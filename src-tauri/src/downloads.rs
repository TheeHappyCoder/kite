//! Downloads in the main window (a file's Download button, Save image, Export CSV, a signed copy):
//! WebView2 left alone drops them in this shell, so Kite takes them itself. Each goes to the user's
//! Downloads folder under its own name ("Invoice (2).pdf" when that's taken), and the page says where
//! it went once it's saved. Windows still writes its download note (Mark of the Web) on the file.

use std::path::{Path, PathBuf};
use tauri::webview::DownloadEvent;
use tauri::{Runtime, Webview};

pub fn handle<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let name = destination.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "download".into());
            let folder = downloads_folder().or_else(|| destination.parent().map(Path::to_path_buf));
            if let Some(folder) = folder {
                *destination = free_path(&folder, Path::new(&name));
            }
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            let name = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let script = format!("window.__kiteDownloaded?.({}, {})", serde_json::Value::String(name), success);
            let _ = webview.eval(&script);
            true
        }
        _ => true,
    }
}

fn downloads_folder() -> Option<PathBuf> {
    let folder = PathBuf::from(std::env::var_os("USERPROFILE")?).join("Downloads");
    folder.is_dir().then_some(folder)
}

/// `name` in `folder`, or "name (2).ext", "name (3).ext"… when it's taken: a download never replaces a file.
fn free_path(folder: &Path, name: &Path) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| folder.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}
