//! Explorer's right-click entries (registered by installer-hooks.nsh): "Show the email in Kite"
//! (`--show-email <path>`) and "Send back in Kite" (`--send-back <path>`). Explorer starts kite.exe
//! once per selected file and the single-instance plugin hands each launch to the running Kite.
//! Each file is looked up here (the drive's own ids, Windows' download note, a SHA-256), so only ids,
//! a hash and the name reach the page (`__kiteFindFiles`, components/files/file-origin.tsx). Send
//! back also uploads the file the way compose does, so the reply opens with it attached.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::server::ORIGIN;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Show,
    Reply,
}

/// Files that arrived together (one right-click on several files) go to the page as one lookup.
#[derive(Default)]
pub struct Pending(Mutex<Vec<(Mode, PathBuf)>>);

/// Bigger files are looked up by name only (the page does the same for drops).
const MAX_HASH_BYTES: u64 = 512 * 1024 * 1024;

/// Handles the paths in a launch's arguments; false when there were none.
pub fn handle(app: &AppHandle, args: &[String]) -> bool {
    let Some(at) = args.iter().position(|a| a == "--show-email" || a == "--send-back") else { return false };
    let mode = if args[at] == "--send-back" { Mode::Reply } else { Mode::Show };
    let paths: Vec<_> = args[at + 1..].iter().map(PathBuf::from).collect();
    if paths.is_empty() {
        return false;
    }
    let state = app.state::<Pending>();
    let first = {
        let mut pending = state.0.lock().unwrap();
        let first = pending.is_empty();
        pending.extend(paths.into_iter().map(|p| (mode, p)));
        first
    };
    if first {
        // Explorer starts the launches one after another: wait a moment for the rest, then work off
        // Explorer's thread (hashing and uploading take a moment).
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let state = app.state::<Pending>();
            let all: Vec<_> = std::mem::take(&mut *state.0.lock().unwrap());
            for mode in [Mode::Show, Mode::Reply] {
                let files: Vec<_> = all.iter().filter(|(m, _)| *m == mode).filter_map(|(_, p)| file(&app, p, mode)).collect();
                if !files.is_empty() {
                    send(&app, mode, files);
                }
            }
        });
    }
    true
}

fn file(app: &AppHandle, path: &Path, mode: Mode) -> Option<serde_json::Value> {
    let mut found = lookup(app, path)?;
    if mode == Mode::Reply {
        match tauri::async_runtime::block_on(upload(path)) {
            Ok(upload) => found["attach"] = upload,
            Err(error) => found["attachError"] = serde_json::Value::String(error),
        }
    }
    Some(found)
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

/// The file as an outgoing attachment (POST /api/uploads, as compose sends it): its `upload` ref, or why not.
async fn upload(path: &Path) -> Result<serde_json::Value, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "attachment".into());
    let data = std::fs::read(path).map_err(|_| format!("Kite couldn't read {name}."))?;
    let response = reqwest::Client::new()
        .post(format!("{ORIGIN}/api/uploads"))
        // The route only takes uploads from Kite's own origin, with raw bytes.
        .header("origin", ORIGIN)
        .header("content-type", "application/octet-stream")
        .header("x-file-name", encode(&name))
        .body(data)
        .send()
        .await
        .map_err(|_| "Kite isn't ready yet. Try again in a moment.".to_string())?;
    let ok = response.status().is_success();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    match (ok, &body["upload"]) {
        (true, upload) if upload.is_object() => {
            let mut upload = upload.clone();
            upload["type"] = "upload".into();
            Ok(upload)
        }
        _ => Err(body["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("{name} couldn't be attached."))),
    }
}

/// The attachment a file was downloaded from, by Windows' Mark of the Web (`<file>:Zone.Identifier`):
/// only when its address is Kite's own attachment link.
fn downloaded_from(path: &Path) -> Option<(String, String, String)> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let note = std::fs::read_to_string(stream).ok()?;
    let url = note.lines().find_map(|l| l.strip_prefix("HostUrl="))?.trim();
    let rest = url.strip_prefix(&format!("{ORIGIN}/api/attachments/"))?;
    let mut parts = rest.split('?').next()?.split('/').map(decode);
    let found = (parts.next()??, parts.next()??, parts.next()??);
    Some(found)
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
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

fn send(app: &AppHandle, mode: Mode, files: Vec<serde_json::Value>) {
    crate::show(app);
    let Some(window) = app.get_webview_window("main") else { return };
    // Release cold start: the splash shows until the server is up, then the window navigates (and a script
    // given to the splash would be lost).
    for _ in 0..360 {
        if window.url().is_ok_and(|url| url.as_str().starts_with(ORIGIN)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let mode = if mode == Mode::Reply { "reply" } else { "show" };
    // On a cold start the page is still loading: try again until the app has set its hook (a minute at most).
    let script = format!(
        "(() => {{ const files = {}; let tries = 0; const go = () => window.__kiteFindFiles ? window.__kiteFindFiles(files, \"{mode}\") : ++tries < 240 && setTimeout(go, 250); go(); }})()",
        serde_json::Value::Array(files)
    );
    if window.eval(&script).is_err() {
        eprintln!("[kite] couldn't hand the files to the page");
    }
}
