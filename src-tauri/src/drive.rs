//! The Kite drive: every file in your mail as folders in Explorer (lib/drive.ts), through Windows'
//! Cloud Files API, the one OneDrive uses. Off until the user turns it on (preference `drive.on`).
//!
//! The server lists the whole tree (GET /api/drive, from the local copy); this keeps one placeholder
//! per file (no bytes, a cloud icon) under %USERPROFILE%\Kite and changes only what moved. Opening a
//! file downloads it through Kite's own attachment route; when the real size differs from the
//! provider's estimate the download restarts with the right size. Read-only: deleting or renaming
//! in Explorer is refused, so nothing there touches mail. Turning it off disconnects, unregisters and
//! deletes the folder with everything downloaded into it.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Storage::Provider::{
    StorageProviderHardlinkPolicy, StorageProviderHydrationPolicy, StorageProviderHydrationPolicyModifier,
    StorageProviderInSyncPolicy, StorageProviderPopulationPolicy, StorageProviderProtectionMode,
    StorageProviderSyncRootInfo, StorageProviderSyncRootManager,
};
use windows::Storage::StorageFolder;
use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree, NTSTATUS};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::CloudFilters::*;
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY, FILE_BASIC_INFO};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::server::ORIGIN;

const STATUS_SUCCESS: NTSTATUS = NTSTATUS(0);
/// STATUS_ACCESS_DENIED: what Explorer is told when someone deletes or renames in the drive.
const STATUS_ACCESS_DENIED: NTSTATUS = NTSTATUS(0xC000_0022u32 as i32);
/// STATUS_UNSUCCESSFUL: a file couldn't be downloaded (offline, the mail is gone).
const STATUS_UNSUCCESSFUL: NTSTATUS = NTSTATUS(0xC000_0001u32 as i32);
/// Transfers go in 1 MiB pieces (the API wants 4 KiB multiples except at the end of the file).
const CHUNK: usize = 1 << 20;

#[derive(Default)]
pub struct Drive(Mutex<State>);

#[derive(Default)]
struct State {
    /// The connection while the drive is on.
    key: Option<CF_CONNECTION_KEY>,
    /// The server's version of the tree this was last made from.
    version: String,
    /// The last download, kept for the restart that follows a size correction.
    last: Option<(String, Vec<u8>)>,
    /// What each file in the drive is (its id, "<account>\n<message>\n<part>"), by its path under the root:
    /// Explorer's "Show the email" on a drive file needs no hashing (which would download it).
    ids: HashMap<PathBuf, String>,
}

#[derive(Deserialize)]
struct Tree {
    on: bool,
    #[serde(default)]
    version: String,
    #[serde(default)]
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    dir: Vec<String>,
    name: String,
    id: String,
    bytes: u64,
    time: i64,
}

/// A dev build gets a drive of its own beside an installed Kite's.
const fn label() -> &'static str {
    if cfg!(debug_assertions) { "Kite (dev)" } else { "Kite" }
}

fn root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(label()))
}

/// Follows the preference: checks now, then every minute, and whenever settings change (`poke`).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            sync(&app).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

/// Settings changed: look again now (the drive may have been switched on or off, or its layout changed).
pub fn poke(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { sync(&app).await });
}

/// One pass at a time: a pass asked for while another runs (switched off then on, a tick during a
/// settings change) runs once that one is done, so two never place the same files.
static RUNNING: AtomicBool = AtomicBool::new(false);
static AGAIN: AtomicBool = AtomicBool::new(false);

async fn sync(app: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        AGAIN.store(true, Ordering::SeqCst);
        return;
    }
    loop {
        AGAIN.store(false, Ordering::SeqCst);
        pass(app).await;
        if !AGAIN.load(Ordering::SeqCst) {
            break;
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
}

async fn pass(app: &AppHandle) {
    let since = app.state::<Drive>().0.lock().unwrap().version.clone();
    let Ok(response) = reqwest::get(format!("{ORIGIN}/api/drive?since={since}")).await else { return };
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return;
    }
    let Ok(tree) = response.json::<Tree>().await else { return };
    let app = app.clone();
    // Placeholders and registration are blocking Windows calls.
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if tree.on {
            if let Err(error) = apply(&app, tree) {
                eprintln!("[kite] drive: {error}");
            }
        } else {
            turn_off(&app);
        }
    })
    .await;
}

fn apply(app: &AppHandle, tree: Tree) -> windows::core::Result<()> {
    let Some(root) = root() else { return Ok(()) };
    let drive = app.state::<Drive>();
    if drive.0.lock().unwrap().key.is_none() {
        std::fs::create_dir_all(&root).map_err(|e| windows::core::Error::new(windows::core::HRESULT(-1), e.to_string()))?;
        register(&root)?;
        let key = connect(&root)?;
        drive.0.lock().unwrap().key = Some(key);
    }
    reconcile(&root, &tree.entries);
    let ids = tree.entries.iter().filter(|e| !e.name.is_empty()).map(|e| (e.dir.iter().collect::<PathBuf>().join(&e.name), e.id.clone())).collect();
    let mut state = drive.0.lock().unwrap();
    state.version = tree.version;
    state.ids = ids;
    Ok(())
}

/// Switched off (or never on): nothing of the drive stays on this computer.
fn turn_off(app: &AppHandle) {
    let Some(root) = root() else { return };
    let drive = app.state::<Drive>();
    let key = {
        let mut state = drive.0.lock().unwrap();
        state.version.clear();
        state.last = None;
        state.ids.clear();
        state.key.take()
    };
    if let Some(key) = key {
        let _ = unsafe { CfDisconnectSyncRoot(key) };
    }
    if !root.exists() {
        return;
    }
    if let Ok(id) = sync_root_id() {
        let _ = StorageProviderSyncRootManager::Unregister(&id);
    }
    if let Err(error) = std::fs::remove_dir_all(&root) {
        eprintln!("[kite] drive: couldn't remove {}: {error}", root.display());
    }
}

/// The email a file in the drive belongs to, as (account, message, part); None outside the drive.
pub fn file_id(app: &AppHandle, path: &Path) -> Option<(String, String, String)> {
    let relative = path.strip_prefix(root()?).ok()?;
    let id = app.state::<Drive>().0.lock().unwrap().ids.get(relative)?.clone();
    let mut parts = id.splitn(3, '\n').map(str::to_string);
    Some((parts.next()?, parts.next()?, parts.next()?))
}

/// Disconnects on quit; the placeholders stay, and open again once Kite runs.
pub fn stop(app: &AppHandle) {
    if let Some(key) = app.state::<Drive>().0.lock().unwrap().key.take() {
        let _ = unsafe { CfDisconnectSyncRoot(key) };
    }
}

// ---- Registration ----

/// "Kite!<user SID>!local" (the format Windows asks for: provider, user, account).
fn sync_root_id() -> windows::core::Result<HSTRING> {
    let provider = label().replace(['!', ' ', '(', ')'], "");
    Ok(HSTRING::from(format!("{provider}!{}!local", user_sid()?)))
}

fn user_sid() -> windows::core::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        let mut buffer = vec![0u8; size as usize];
        GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr() as *mut c_void), size, &mut size)?;
        let _ = windows::Win32::Foundation::CloseHandle(token);
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text)?;
        let sid = text.to_string().unwrap_or_default();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
        Ok(sid)
    }
}

/// Explorer's side panel gets a Kite entry (registering again only updates it).
fn register(root: &Path) -> windows::core::Result<()> {
    let info = StorageProviderSyncRootInfo::new()?;
    info.SetId(&sync_root_id()?)?;
    let folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(root.as_os_str()))?.join()?;
    info.SetPath(&folder)?;
    info.SetDisplayNameResource(&HSTRING::from(label()))?;
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    info.SetIconResource(&HSTRING::from(format!("{exe},0")))?;
    info.SetHydrationPolicy(StorageProviderHydrationPolicy::Full)?;
    // The provider's sizes are estimates for IMAP and Outlook: a download may restart with the real one.
    info.SetHydrationPolicyModifier(StorageProviderHydrationPolicyModifier::AllowFullRestartHydration)?;
    // Kite keeps the whole tree itself; Windows never asks for a folder's contents.
    info.SetPopulationPolicy(StorageProviderPopulationPolicy::AlwaysFull)?;
    info.SetInSyncPolicy(StorageProviderInSyncPolicy::Default)?;
    info.SetHardlinkPolicy(StorageProviderHardlinkPolicy::None)?;
    info.SetProtectionMode(StorageProviderProtectionMode::Personal)?;
    info.SetShowSiblingsAsGroup(false)?;
    info.SetAllowPinning(true)?;
    info.SetVersion(&HSTRING::from(env!("CARGO_PKG_VERSION")))?;
    StorageProviderSyncRootManager::Register(&info)
}

fn connect(root: &Path) -> windows::core::Result<CF_CONNECTION_KEY> {
    // Windows keeps a pointer to the table for as long as the connection lives: it stays for the app's life.
    static CALLBACKS: [CF_CALLBACK_REGISTRATION; 4] = [
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_DATA, Callback: Some(fetch_data) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_DELETE, Callback: Some(on_delete) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_RENAME, Callback: Some(on_rename) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NONE, Callback: None },
    ];
    unsafe {
        CfConnectSyncRoot(
            &HSTRING::from(root.as_os_str()),
            CALLBACKS.as_ptr(),
            None,
            CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO | CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH,
        )
    }
}

// ---- The tree on disk ----

fn reconcile(root: &Path, entries: &[Entry]) {
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    let mut files: HashMap<PathBuf, &Entry> = HashMap::new();
    for entry in entries {
        let mut dir = PathBuf::new();
        for part in &entry.dir {
            dir.push(part);
            dirs.insert(dir.clone());
        }
        if !entry.name.is_empty() {
            files.insert(dir.join(&entry.name), entry);
        }
    }
    // What's there: placeholders from an earlier run included (same path = same file; a clash adds
    // the sender and date to the name, so a path names one file).
    let mut have_dirs = HashSet::new();
    let mut have_files = HashSet::new();
    walk(root, Path::new(""), &mut have_dirs, &mut have_files);
    // Gone from the tree: deepest first, so a folder goes after its contents.
    for file in have_files.iter().filter(|f| !files.contains_key(*f)) {
        let _ = std::fs::remove_file(root.join(file));
    }
    let mut stale: Vec<_> = have_dirs.iter().filter(|d| !dirs.contains(*d)).collect();
    stale.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for dir in stale {
        let _ = std::fs::remove_dir_all(root.join(dir));
    }
    // New folders, parents first.
    let mut new_dirs: Vec<_> = dirs.iter().filter(|d| !have_dirs.contains(*d)).collect();
    new_dirs.sort_by_key(|d| d.components().count());
    for dir in new_dirs {
        create(root, dir, None);
    }
    for (path, entry) in files.iter().filter(|(p, _)| !have_files.contains(*p)) {
        create(root, path, Some(entry));
    }
}

fn walk(root: &Path, at: &Path, dirs: &mut HashSet<PathBuf>, files: &mut HashSet<PathBuf>) {
    let Ok(list) = std::fs::read_dir(root.join(at)) else { return };
    for item in list.flatten() {
        let path = at.join(item.file_name());
        match item.file_type() {
            Ok(t) if t.is_dir() => {
                dirs.insert(path.clone());
                walk(root, &path, dirs, files);
            }
            Ok(_) => {
                files.insert(path);
            }
            Err(_) => {}
        }
    }
}

/// 100 ns ticks since 1601, from ms since 1970.
fn filetime(ms: i64) -> i64 {
    ms.max(0) * 10_000 + 116_444_736_000_000_000
}

/// The blob each file placeholder carries: its id and time, read back when it's opened.
fn blob(entry: &Entry) -> Vec<u8> {
    format!("{}\n{}", entry.id, entry.time).into_bytes()
}

/// `kind`: a folder, a file still being placed (writable, for its internet mark) or a placed file
/// (read-only, so Word and friends open the copy as one).
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Folder,
    Placing,
    File,
}

fn basic_info(time: i64, kind: Kind) -> FILE_BASIC_INFO {
    let t = filetime(time);
    FILE_BASIC_INFO {
        CreationTime: t,
        LastAccessTime: t,
        LastWriteTime: t,
        ChangeTime: t,
        FileAttributes: match kind {
            Kind::Folder => FILE_ATTRIBUTE_DIRECTORY.0,
            Kind::Placing => FILE_ATTRIBUTE_ARCHIVE.0,
            Kind::File => FILE_ATTRIBUTE_READONLY.0,
        },
    }
}

/// Windows' own "came from the internet" note (Mark of the Web), the one a browser writes on every
/// download: SmartScreen asks before a program runs and Office opens documents in Protected View.
/// Its address is Kite's attachment link, so a copy taken out of the drive still traces back to its
/// email (origin.rs reads it). Ids only, never names or text.
fn mark_from_internet(path: &Path, id: &str) -> std::io::Result<()> {
    let mut parts = id.splitn(3, '\n');
    let (account, message, part) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let note = format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={ORIGIN}/api/attachments/{}/{}/{}?download=1\r\n", encode(account), encode(message), encode(part));
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    std::fs::write(stream, note)
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn create(root: &Path, path: &Path, entry: Option<&Entry>) {
    let Some(name) = path.file_name() else { return };
    let parent = root.join(path.parent().unwrap_or(Path::new("")));
    let name = HSTRING::from(name);
    let identity = entry.map(blob).unwrap_or_else(|| b"dir".to_vec());
    let mut info = CF_PLACEHOLDER_CREATE_INFO {
        RelativeFileName: PCWSTR(name.as_ptr()),
        FsMetadata: CF_FS_METADATA {
            BasicInfo: basic_info(entry.map_or(0, |e| e.time), if entry.is_none() { Kind::Folder } else { Kind::Placing }),
            FileSize: entry.map_or(0, |e| e.bytes as i64),
        },
        FileIdentity: identity.as_ptr() as *const c_void,
        FileIdentityLength: identity.len() as u32,
        Flags: CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC
            | if entry.is_none() { CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION } else { CF_PLACEHOLDER_CREATE_FLAG_NONE },
        ..Default::default()
    };
    let result = unsafe { CfCreatePlaceholders(&HSTRING::from(parent.as_os_str()), std::slice::from_mut(&mut info), CF_CREATE_FLAG_NONE, None) };
    if let Err(error) = result {
        eprintln!("[kite] drive: couldn't place {}: {error}", path.display());
        return;
    }
    // Marked while still writable, then made read-only.
    if let Some(entry) = entry {
        let full = root.join(path);
        if let Err(error) = mark_from_internet(&full, &entry.id) {
            eprintln!("[kite] drive: couldn't mark {}: {error}", path.display());
        }
        if let Ok(meta) = std::fs::metadata(&full) {
            let mut permissions = meta.permissions();
            permissions.set_readonly(true);
            let _ = std::fs::set_permissions(&full, permissions);
        }
    }
}

// ---- Callbacks (on Windows' threads) ----

struct Fetch {
    connection: CF_CONNECTION_KEY,
    transfer: i64,
    request: i64,
    /// "<account>\n<message>\n<part>"
    id: String,
    time: i64,
    size: i64,
    offset: i64,
    length: i64,
}

unsafe extern "system" fn fetch_data(info: *const CF_CALLBACK_INFO, params: *const CF_CALLBACK_PARAMETERS) {
    let (info, params) = unsafe { (&*info, &*params) };
    let identity = unsafe { std::slice::from_raw_parts(info.FileIdentity as *const u8, info.FileIdentityLength as usize) };
    let text = String::from_utf8_lossy(identity);
    let (id, time) = text.rsplit_once('\n').unwrap_or((&text, "0"));
    let required = unsafe { params.Anonymous.FetchData };
    let fetch = Fetch {
        connection: info.ConnectionKey,
        transfer: info.TransferKey,
        request: info.RequestKey,
        id: id.to_string(),
        time: time.parse().unwrap_or(0),
        size: info.FileSize,
        offset: required.RequiredFileOffset,
        length: required.RequiredLength,
    };
    // Answered from Kite's runtime: Windows waits (up to a minute) for the transfer.
    let Some(app) = APP.get().cloned() else { return };
    tauri::async_runtime::spawn(async move { serve(&app, fetch).await });
}

async fn serve(app: &AppHandle, fetch: Fetch) {
    let cached = app.state::<Drive>().0.lock().unwrap().last.as_ref().filter(|(id, _)| *id == fetch.id).map(|(_, data)| data.clone());
    let data = match cached {
        Some(data) => Some(data),
        None => download(&fetch.id).await,
    };
    let Some(data) = data else {
        transfer(&fetch, None, fetch.offset, fetch.length);
        return;
    };
    app.state::<Drive>().0.lock().unwrap().last = Some((fetch.id.clone(), data.clone()));
    if data.len() as i64 != fetch.size {
        // The estimate was off: start again at the real size (Windows asks for the data once more).
        restart(&fetch, data.len() as i64);
        return;
    }
    let mut at = 0usize;
    while at < data.len() {
        let end = (at + CHUNK).min(data.len());
        if !transfer(&fetch, Some(&data[at..end]), at as i64, (end - at) as i64) {
            return;
        }
        at = end;
    }
    if data.is_empty() {
        transfer(&fetch, Some(&[]), 0, 0);
    }
}

async fn download(id: &str) -> Option<Vec<u8>> {
    let mut parts = id.split('\n');
    let (account, message, part) = (parts.next()?, parts.next()?, parts.next()?);
    let url = format!("{ORIGIN}/api/attachments/{}/{}/{}?download=1", encode(account), encode(message), encode(part));
    let response = reqwest::get(url).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.bytes().await.ok().map(|b| b.to_vec())
}

fn operation(fetch: &Fetch, kind: CF_OPERATION_TYPE) -> CF_OPERATION_INFO {
    CF_OPERATION_INFO {
        StructSize: std::mem::size_of::<CF_OPERATION_INFO>() as u32,
        Type: kind,
        ConnectionKey: fetch.connection,
        TransferKey: fetch.transfer,
        RequestKey: fetch.request,
        ..Default::default()
    }
}

/// Sends a piece of the file, or (no data) tells Windows the download failed.
fn transfer(fetch: &Fetch, data: Option<&[u8]>, offset: i64, length: i64) -> bool {
    let info = operation(fetch, CF_OPERATION_TYPE_TRANSFER_DATA);
    let failed = [0u8; 1];
    let mut params = CF_OPERATION_PARAMETERS {
        ParamSize: std::mem::size_of::<CF_OPERATION_PARAMETERS>() as u32,
        Anonymous: CF_OPERATION_PARAMETERS_0 {
            TransferData: CF_OPERATION_PARAMETERS_0_0 {
                Flags: CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
                CompletionStatus: if data.is_some() { STATUS_SUCCESS } else { STATUS_UNSUCCESSFUL },
                Buffer: data.map_or(failed.as_ptr(), |d| d.as_ptr()) as *const c_void,
                Offset: offset,
                Length: length,
            },
        },
    };
    match unsafe { CfExecute(&info, &mut params) } {
        Ok(()) => data.is_some(),
        Err(error) => {
            eprintln!("[kite] drive: transfer failed: {error}");
            false
        }
    }
}

fn restart(fetch: &Fetch, size: i64) {
    let info = operation(fetch, CF_OPERATION_TYPE_RESTART_HYDRATION);
    let metadata = CF_FS_METADATA { BasicInfo: basic_info(fetch.time, Kind::File), FileSize: size };
    let mut params = CF_OPERATION_PARAMETERS {
        ParamSize: std::mem::size_of::<CF_OPERATION_PARAMETERS>() as u32,
        Anonymous: CF_OPERATION_PARAMETERS_0 {
            RestartHydration: CF_OPERATION_PARAMETERS_0_3 {
                Flags: CF_OPERATION_RESTART_HYDRATION_FLAG_MARK_IN_SYNC,
                FsMetadata: &metadata,
                ..Default::default()
            },
        },
    };
    if let Err(error) = unsafe { CfExecute(&info, &mut params) } {
        eprintln!("[kite] drive: couldn't correct the size: {error}");
        transfer(fetch, None, fetch.offset, fetch.length);
    }
}

/// Only Kite itself removes or renames things in the drive.
fn ours(info: &CF_CALLBACK_INFO) -> bool {
    !info.ProcessInfo.is_null() && unsafe { (*info.ProcessInfo).ProcessId } == std::process::id()
}

unsafe extern "system" fn on_delete(info: *const CF_CALLBACK_INFO, _params: *const CF_CALLBACK_PARAMETERS) {
    let info = unsafe { &*info };
    let fetch = Fetch { connection: info.ConnectionKey, transfer: info.TransferKey, request: info.RequestKey, id: String::new(), time: 0, size: 0, offset: 0, length: 0 };
    let mut params = CF_OPERATION_PARAMETERS {
        ParamSize: std::mem::size_of::<CF_OPERATION_PARAMETERS>() as u32,
        Anonymous: CF_OPERATION_PARAMETERS_0 {
            AckDelete: CF_OPERATION_PARAMETERS_0_7 { Flags: CF_OPERATION_ACK_DELETE_FLAG_NONE, CompletionStatus: if ours(info) { STATUS_SUCCESS } else { STATUS_ACCESS_DENIED } },
        },
    };
    let _ = unsafe { CfExecute(&operation(&fetch, CF_OPERATION_TYPE_ACK_DELETE), &mut params) };
}

unsafe extern "system" fn on_rename(info: *const CF_CALLBACK_INFO, _params: *const CF_CALLBACK_PARAMETERS) {
    let info = unsafe { &*info };
    let fetch = Fetch { connection: info.ConnectionKey, transfer: info.TransferKey, request: info.RequestKey, id: String::new(), time: 0, size: 0, offset: 0, length: 0 };
    let mut params = CF_OPERATION_PARAMETERS {
        ParamSize: std::mem::size_of::<CF_OPERATION_PARAMETERS>() as u32,
        Anonymous: CF_OPERATION_PARAMETERS_0 {
            AckRename: CF_OPERATION_PARAMETERS_0_6 { Flags: CF_OPERATION_ACK_RENAME_FLAG_NONE, CompletionStatus: if ours(info) { STATUS_SUCCESS } else { STATUS_ACCESS_DENIED } },
        },
    };
    let _ = unsafe { CfExecute(&operation(&fetch, CF_OPERATION_TYPE_ACK_RENAME), &mut params) };
}

/// The app, for callbacks Windows makes on its own threads.
pub static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
