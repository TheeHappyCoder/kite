mod codes;
mod bar;
mod server;
mod tray;
mod updater;

use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub fn run() {
    // Single instance must come first: a second launch focuses the running Kite instead.
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)));
    // Windows toasts use WinRT directly (buttons); elsewhere the notification plugin.
    #[cfg(not(windows))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            // The one global shortcut (a setting) copies the newest fresh code.
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        codes::copy_newest(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(server::Server::default())
        .manage(codes::Codes::default())
        .manage(bar::Bar::default())
        .manage(updater::Updates::default())
        .invoke_handler(tauri::generate_handler![bar::bar, updater::update])
        .setup(|app| {
            // Debug: the dev server is already up (`tauri dev` waits for it). Release: a splash until Node is ready.
            let url = if cfg!(debug_assertions) {
                WebviewUrl::External(server::ORIGIN.parse().unwrap())
            } else {
                WebviewUrl::App("index.html".into())
            };
            // Links that open a new window (target="_blank": Google's App passwords page, links in
            // mail) go to the default browser; the webview never opens windows of its own.
            let opener = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", url)
                .title("Kite")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script("window.__KITE_DESKTOP__ = true;")
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            tray::create(app.handle())?;
            codes::start(app.handle());
            updater::start(app.handle());
            if cfg!(debug_assertions) {
                bar::create(app.handle());
            } else {
                let handle = app.handle().clone();
                std::thread::spawn(move || boot(&handle));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray; Quit in the tray menu exits.
            if let ("main", WindowEvent::CloseRequested { api, .. }) = (window.label(), event) {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Kite")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                server::stop(app);
            }
        });
}

/// Release: start the bundled server, then swap the splash for the app.
fn boot(app: &AppHandle) {
    let status = match server::start(app) {
        Ok(child) => {
            *app.state::<server::Server>().0.lock().unwrap() = child;
            server::wait_until_up(Duration::from_secs(60))
        }
        Err(error) => {
            eprintln!("[kite] couldn't start the server: {error}");
            false
        }
    };
    let Some(window) = app.get_webview_window("main") else { return };
    if status {
        let _ = window.navigate(server::ORIGIN.parse().unwrap());
        bar::create(app);
    } else {
        let _ = window.eval(
            "document.getElementById('status').textContent = \"Kite couldn't start its local server. Quit Kite from the tray and open it again.\"",
        );
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
