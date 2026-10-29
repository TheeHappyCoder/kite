//! Updates from GitHub: the latest release's `latest.json` (tauri.conf.json `plugins.updater`), signed
//! with Kite's update key, so only a build Kite made installs. Checked shortly after start and every
//! six hours (and from Settings → About on request); the main window reads the state through the `update` command and shows the rail's
//! update button when there's one. Installing: download (with progress), stop the bundled server so no
//! file is in use, then the installer runs (passive), clears the old version's files
//! (installer-hooks.nsh) and opens Kite again. The user's data is never touched.

use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// How often Kite looks for a new version while it runs.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// "idle" (nothing new), "available", "downloading", "installing" or "error".
    pub phase: String,
    /// This version.
    pub current: String,
    /// The new version and its release notes, while there is one.
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Updates(pub Mutex<UpdateState>, AtomicBool);

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
}
fn begin(updates: &Updates) -> Option<Operation<'_>> {
    updates.1.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .ok().map(|_| Operation(&updates.1))
}

fn set(app: &AppHandle, change: impl FnOnce(&mut UpdateState)) {
    let state = app.state::<Updates>();
    let mut current = state.0.lock().unwrap();
    change(&mut current);
}

/// Starts the checks (release builds only: a dev build has nothing to update from).
pub fn start(app: &AppHandle) {
    set(app, |s| {
        s.phase = "idle".into();
        s.current = app.package_info().version.to_string();
    });
    if cfg!(debug_assertions) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            check(&handle, false).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// `manual`: Settings → About asked, so a failure is reported; the timed checks stay quiet.
async fn check(app: &AppHandle, manual: bool) {
    let updates = app.state::<Updates>();
    let Some(_operation) = begin(&updates) else { return };
    // Not while one is on its way in.
    if matches!(app.state::<Updates>().0.lock().unwrap().phase.as_str(), "downloading" | "installing") {
        return;
    }
    let Ok(updater) = app.updater() else { return };
    match updater.check().await {
        Ok(Some(update)) => set(app, |s| {
            s.phase = "available".into();
            s.version = Some(update.version.clone());
            s.notes = update.body.clone();
            s.date = update.date.map(|d| d.to_string());
            s.error = None;
        }),
        Ok(None) => set(app, |s| {
            s.phase = "idle".into();
            s.version = None;
            s.notes = None;
            s.error = None;
        }),
        // Offline or GitHub unreachable: the timed checks try again next time, quietly.
        Err(_) if manual => set(app, |s| s.error = Some("Couldn't reach GitHub. Check your connection and try again.".into())),
        Err(_) => {}
    }
}

async fn install(app: AppHandle) {
    let updates = app.state::<Updates>();
    let Some(_operation) = begin(&updates) else { return };
    set(&app, |s| { s.phase = "downloading".into(); s.downloaded = 0; s.total = None; s.error = None; });
    let failed = |app: &AppHandle, message: String| {
        set(app, |s| {
            s.phase = "error".into();
            s.error = Some(message);
        })
    };
    let Ok(updater) = app.updater() else { return failed(&app, "Updates aren't set up in this build.".into()) };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return set(&app, |s| { s.phase = "idle".into(); s.version = None; s.notes = None; }),
        Err(error) => return failed(&app, format!("Couldn't reach GitHub: {error}")),
    };
    set(&app, |s| {
        s.phase = "downloading".into();
        s.downloaded = 0;
        s.total = None;
        s.error = None;
        s.version = Some(update.version.clone());
        s.notes = update.body.clone();
    });
    let progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                set(&progress, |s| {
                    s.downloaded += chunk as u64;
                    s.total = total;
                })
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => return failed(&app, format!("The download stopped: {error}")),
    };
    set(&app, |s| s.phase = "installing".into());
    // Give the window a moment to show "Installing", then free the files the installer replaces.
    tokio::time::sleep(Duration::from_millis(900)).await;
    crate::server::stop(&app);
    tokio::time::sleep(Duration::from_millis(600)).await;
    // The installer takes over from here (passive: a small progress window) and opens Kite again.
    if let Err(error) = update.install(bytes) {
        if let Ok(child) = crate::server::start(&app) {
            *app.state::<crate::server::Server>().0.lock().unwrap() = child;
        }
        failed(&app, format!("The installer didn't start: {error}"));
    }
}

/// From the main window: `status` (what's known now), `check` (look now), `install` (download, install, restart).
#[tauri::command]
pub async fn update(app: AppHandle, action: String) -> UpdateState {
    match action.as_str() {
        "check" if !cfg!(debug_assertions) => check(&app, true).await,
        "install" if !cfg!(debug_assertions) => {
            let handle = app.clone();
            tauri::async_runtime::spawn(install(handle));
        }
        _ => {}
    }
    app.state::<Updates>().0.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_operations_are_exclusive_and_release_on_failure() {
        let updates = Updates::default();
        let operation = begin(&updates).unwrap();
        assert!(begin(&updates).is_none());
        drop(operation);
        assert!(begin(&updates).is_some());
    }
}
