//! "Show the email" from Explorer's right-click menu (registered by installer-hooks.nsh): Explorer
//! starts `kite.exe --show-email <path>` once per selected file, and the single-instance plugin hands
//! each one to the running Kite. The file is hashed here, so it never leaves this computer; the page
//! gets its name and SHA-256 (`__kiteFindFiles`, components/files/file-origin.tsx) and looks it up.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Files that arrived together (one right-click on several files) go to the page as one lookup.
#[derive(Default)]
pub struct Pending(Mutex<Vec<serde_json::Value>>);

const FLAG: &str = "--show-email";
/// Bigger files are looked up by name only (the page does the same for drops).
const MAX_HASH_BYTES: u64 = 512 * 1024 * 1024;

/// Handles the paths in a launch's arguments; false when there were none.
pub fn handle(app: &AppHandle, args: &[String]) -> bool {
    let paths: Vec<&String> = args.iter().skip_while(|a| a.as_str() != FLAG).skip(1).collect();
    if paths.is_empty() {
        return false;
    }
    let files: Vec<_> = paths.iter().filter_map(|p| lookup(app, Path::new(p))).collect();
    let state = app.state::<Pending>();
    let first = {
        let mut pending = state.0.lock().unwrap();
        let first = pending.is_empty();
        pending.extend(files);
        first
    };
    if first {
        // Explorer starts the launches one after another: wait a moment for the rest.
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            send(&app);
        });
    }
    true
}

fn lookup(app: &AppHandle, path: &Path) -> Option<serde_json::Value> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    // A file in the Kite drive says which email it is; hashing it would download it first.
    #[cfg(windows)]
    if let Some((account, message, part)) = crate::drive::file_id(app, path) {
        return Some(serde_json::json!({ "name": name, "sha": null, "part": { "accountId": account, "messageId": message, "partId": part } }));
    }
    #[cfg(not(windows))]
    let _ = app;
    let size = path.metadata().ok().filter(|m| m.is_file())?.len();
    let sha = if size > MAX_HASH_BYTES { None } else { hash(path) };
    // Saved from Kite (or copied out of the drive): Windows' download note names the email even after
    // a rename or an edit in place. The hash still goes along in case that email is gone.
    match downloaded_from(path) {
        Some((account, message, part)) => Some(serde_json::json!({ "name": name, "sha": sha, "part": { "accountId": account, "messageId": message, "partId": part } })),
        None => Some(serde_json::json!({ "name": name, "sha": sha })),
    }
}

/// The attachment a file was downloaded from, by Windows' Mark of the Web (`<file>:Zone.Identifier`):
/// only when its address is Kite's own attachment link.
fn downloaded_from(path: &Path) -> Option<(String, String, String)> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let note = std::fs::read_to_string(stream).ok()?;
    let url = note.lines().find_map(|l| l.strip_prefix("HostUrl="))?.trim();
    let rest = url.strip_prefix(&format!("{}/api/attachments/", crate::server::ORIGIN))?;
    let mut parts = rest.split('?').next()?.split('/').map(decode);
    let found = (parts.next()??, parts.next()??, parts.next()??);
    Some(found)
}

fn decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hash(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn send(app: &AppHandle) {
    let state = app.state::<Pending>();
    let files: Vec<_> = std::mem::take(&mut *state.0.lock().unwrap());
    if files.is_empty() {
        return;
    }
    crate::show(app);
    let Some(window) = app.get_webview_window("main") else { return };
    // Release cold start: the splash shows until the server is up, then the window navigates (and a script
    // given to the splash would be lost).
    for _ in 0..360 {
        if window.url().is_ok_and(|url| url.as_str().starts_with(crate::server::ORIGIN)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    // On a cold start the page is still loading: try again until the app has set its hook (a minute at most).
    let script = format!(
        "(() => {{ const files = {}; let tries = 0; const go = () => window.__kiteFindFiles ? window.__kiteFindFiles(files) : ++tries < 240 && setTimeout(go, 250); go(); }})()",
        serde_json::Value::Array(files)
    );
    if window.eval(&script).is_err() {
        eprintln!("[kite] couldn't hand the files to the page");
    }
}
