//! Codes anywhere: fresh sign-in codes and links from the Kite server become native toasts
//! (Copy code / Open link), tray entries and an optional global shortcut. Everything acts only
//! on a click or key press. Codes and links are never logged.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_opener::OpenerExt;

use crate::server::ORIGIN;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    pub id: String,
    pub service: String,
    pub code: Option<String>,
    pub link: Option<String>,
    /// No `code` yet: the parts the user picks from on the Kite bar (first, second, whole).
    #[serde(default)]
    pub choices: Option<Vec<String>>,
}

impl Code {
    /// Kite couldn't tell which part to copy: only the Kite bar can settle it.
    pub fn needs_pick(&self) -> bool {
        self.code.is_none() && self.choices.as_ref().is_some_and(|c| !c.is_empty())
    }
}

/// GET /api/desktop (`DesktopState` in src/lib/desktop.ts). Codes there are already under 10 minutes old.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopState {
    codes: Vec<Code>,
    code_toast: bool,
    code_card: bool,
    #[serde(default)]
    mail_bar: bool,
    code_shortcut: String,
    #[serde(default)]
    bar_quiet: bool,
    #[serde(default)]
    show_content: bool,
}

#[derive(Default)]
pub struct Codes {
    codes: Mutex<Vec<Code>>,
    /// How a fresh code shows: (Windows notification, bar).
    show: Mutex<(bool, bool)>,
    /// Mail a rule said to notify about now shows in the Kite bar (`desktop.mailBar`).
    mail: Mutex<bool>,
    /// Toasts may show the service and the code (`notifications.showContent`).
    content: Mutex<bool>,
    /// The global shortcut currently registered ("" for none).
    shortcut: Mutex<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    Code(Code),
    Meeting(crate::bar::Meeting),
    Mail(crate::bar::Mail),
    Bar(crate::bar::Change),
    Settings,
    Trackers,
    #[serde(other)]
    Other,
}

pub fn start(app: &AppHandle) {
    let listener = app.clone();
    tauri::async_runtime::spawn(async move { listen(listener).await });
    // Re-reading every minute drops codes as they pass 10 minutes.
    let ticker = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            refresh(&ticker).await;
        }
    });
}

/// Follows /api/events, reconnecting with backoff (the release server takes a moment to start).
async fn listen(app: AppHandle) {
    let client = reqwest::Client::new();
    let mut backoff = 1;
    loop {
        if let Ok(mut response) = client.get(format!("{ORIGIN}/api/events")).send().await {
            if response.status().is_success() {
                backoff = 1;
                refresh(&app).await;
                let mut buffer: Vec<u8> = Vec::new();
                while let Ok(Some(chunk)) = response.chunk().await {
                    buffer.extend_from_slice(&chunk);
                    while let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
                        let block: Vec<u8> = buffer.drain(..end + 2).collect();
                        for line in String::from_utf8_lossy(&block).lines() {
                            if let Some(data) = line.strip_prefix("data: ") {
                                handle(&app, data).await;
                            }
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(15);
    }
}

async fn handle(app: &AppHandle, data: &str) {
    match serde_json::from_str::<Event>(data) {
        Ok(Event::Code(code)) => {
            refresh(app).await;
            // The server only sends this when code notifications are on. The Kite bar shows over
            // whatever is on screen, Kite or not (the web app leaves its own bar out in the shell); the
            // Windows notification only when Kite isn't in front.
            let (show_toast, show_card) = *app.state::<Codes>().show.lock().unwrap();
            if show_card {
                crate::bar::show(app, crate::bar::Item::Code(code.clone()));
            }
            if show_toast && !window_focused(app) {
                toast(app, &code);
            }
        }
        // Only sent when meeting notifications are on (server/meetings.ts); the Kite bar is where they show.
        Ok(Event::Meeting(meeting)) => crate::bar::show(app, crate::bar::Item::Meeting(meeting)),
        // The rules decided (notify now); the Kite bar shows it while you're in another app. With Kite in
        // front the mail is already on screen. The web app leaves out its own notification for these.
        Ok(Event::Mail(mail)) => {
            if mail.notify == "now" && *app.state::<Codes>().mail.lock().unwrap() && !window_focused(app) {
                crate::bar::show(app, crate::bar::Item::Mail(mail));
            }
        }
        // Another app's activity (the Kite bar API): the server checked it and who sent it.
        Ok(Event::Bar(change)) => match (change.op.as_str(), change.activity, change.id) {
            ("show", Some(activity), _) => crate::bar::show(app, crate::bar::Item::Activity(activity)),
            ("remove", _, Some(id)) => crate::bar::remove(app, &id),
            _ => {}
        },
        Ok(Event::Settings) => {
            refresh(app).await;
            // The drive may have been switched on or off, or its layout changed.
            #[cfg(windows)]
            crate::drive::poke(app);
        }
        Ok(Event::Trackers) => refresh(app).await,
        _ => {}
    }
}

async fn refresh(app: &AppHandle) {
    let Ok(response) = reqwest::get(format!("{ORIGIN}/api/desktop")).await else { return };
    let Ok(state) = response.json::<DesktopState>().await else { return };
    let codes = app.state::<Codes>();
    *codes.codes.lock().unwrap() = state.codes.clone();
    *codes.show.lock().unwrap() = (state.code_toast, state.code_card);
    *codes.content.lock().unwrap() = state.show_content;
    *codes.mail.lock().unwrap() = state.mail_bar;
    crate::bar::set_quiet(app, state.bar_quiet);
    crate::tray::update(app, &state.codes);
    set_shortcut(app, &state.code_shortcut);
}

fn set_shortcut(app: &AppHandle, wanted: &str) {
    let codes = app.state::<Codes>();
    let mut current = codes.shortcut.lock().unwrap();
    if *current == wanted {
        return;
    }
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if !wanted.is_empty() {
        if let Err(error) = shortcuts.register(wanted) {
            eprintln!("[kite] couldn't register the code shortcut: {error}");
        }
    }
    *current = wanted.to_string();
}

fn window_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// Tray menu ids: `copy:<record id>` and `open:<record id>`.
pub fn act(app: &AppHandle, menu_id: &str) {
    let (action, id) = menu_id.split_once(':').unwrap_or((menu_id, ""));
    let found = app.state::<Codes>().codes.lock().unwrap().iter().find(|c| c.id == id).cloned();
    let Some(code) = found else { return };
    match action {
        "copy" => copy(app, code.code.as_deref()),
        "open" => open(app, code.link.as_deref()),
        "pick" => crate::bar::show(app, crate::bar::Item::Code(code)),
        _ => {}
    }
}

/// The global shortcut: copies the newest fresh code, if there is one.
pub fn copy_newest(app: &AppHandle) {
    let newest = app.state::<Codes>().codes.lock().unwrap().iter().find_map(|c| c.code.clone());
    copy(app, newest.as_deref());
}

/// How long a copied code stays on the clipboard before Kite clears it (if it's still there).
const CLIPBOARD_SECS: u64 = 60;

pub fn copy(app: &AppHandle, code: Option<&str>) {
    let Some(code) = code else { return };
    if app.clipboard().write_text(code.to_string()).is_err() {
        return;
    }
    // Clear it after a minute, unless something else has been copied since.
    let handle = app.clone();
    let copied = code.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(CLIPBOARD_SECS)).await;
        if handle.clipboard().read_text().map(|now| now == copied).unwrap_or(false) {
            let _ = handle.clipboard().write_text(String::new());
        }
    });
}

/// Fill: types the code into whatever has the keyboard (the field you're in: the Kite bar never takes
/// focus, so clicking it leaves the keyboard where it was). Only something shaped like a code goes in
/// (letters, digits and dashes, 16 at most): never a newline or anything that could act as a shortcut.
#[cfg(windows)]
pub fn fill(app: &AppHandle, code: Option<&str>) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY};
    let Some(code) = code.filter(|c| !c.is_empty() && c.len() <= 16 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')) else { return };
    let mut inputs = Vec::with_capacity(code.len() * 2);
    for unit in code.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
            });
        }
    }
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    // Blocked (another app's input is protected, like an elevated window): it's on the clipboard instead.
    if sent as usize != inputs.len() {
        copy(app, Some(code));
    }
}

/// Elsewhere there's no typing for another app: Fill copies.
#[cfg(not(windows))]
pub fn fill(app: &AppHandle, code: Option<&str>) {
    copy(app, code);
}

pub fn open(app: &AppHandle, link: Option<&str>) {
    if let Some(link) = link.filter(|l| l.starts_with("https://")) {
        let _ = app.opener().open_url(link, None::<&str>);
    }
}

#[cfg(windows)]
fn toast(app: &AppHandle, code: &Code) {
    use tauri_winrt_notification::Toast;

    // Installed builds own a Start menu shortcut with the bundle id; dev and target/ builds borrow PowerShell's.
    let installed = std::env::current_exe().map(|p| !p.components().any(|c| c.as_os_str() == "target")).unwrap_or(false);
    let app_id = if installed { app.config().identifier.clone() } else { Toast::POWERSHELL_APP_ID.to_string() };

    // Without "show content" the toast names neither the service nor the code (lock screen, shared screens).
    let content = *app.state::<Codes>().content.lock().unwrap();
    let (title, text) = match (&code.code, &code.link, content) {
        _ if code.needs_pick() => (
            if content { format!("Sign-in code from {}", code.service) } else { "Sign-in code ready".to_string() },
            "Pick which part you type; Kite remembers it.".to_string(),
        ),
        (Some(value), _, true) => (format!("Sign-in code from {}", code.service), value.clone()),
        (Some(_), _, false) => ("Sign-in code ready".to_string(), "Copy it from here, or open Kite.".to_string()),
        (None, Some(_), true) => (format!("Sign-in link from {}", code.service), "Open it in your browser.".to_string()),
        (None, Some(_), false) => ("Sign-in link ready".to_string(), "Open it from here, or open Kite.".to_string()),
        (None, None, _) => return,
    };
    let mut toast = Toast::new(&app_id).title(&title).text1(&text);
    if code.code.is_some() {
        toast = toast.add_button("Copy code", "copy");
    }
    if code.needs_pick() {
        toast = toast.add_button("Pick", "pick");
    }
    if code.link.is_some() {
        toast = toast.add_button("Open link", "open");
    }
    let handle = app.clone();
    let item = code.clone();
    let result = toast
        .on_activated(move |action| {
            match action.as_deref() {
                Some("copy") => copy(&handle, item.code.as_deref()),
                Some("open") => open(&handle, item.link.as_deref()),
                Some("pick") => crate::bar::show(&handle, crate::bar::Item::Code(item.clone())),
                _ => crate::show(&handle),
            }
            Ok(())
        })
        .show();
    if let Err(error) = result {
        eprintln!("[kite] couldn't show a notification: {error}");
    }
}

/// macOS / Linux: a plain notification (no buttons there); copy from the tray or the shortcut.
#[cfg(not(windows))]
fn toast(app: &AppHandle, code: &Code) {
    use tauri_plugin_notification::NotificationExt;
    let content = *app.state::<Codes>().content.lock().unwrap();
    let body = match (&code.code, &code.link, content) {
        (Some(value), _, true) => format!("{value} · copy it from the Kite menu"),
        (Some(_), _, false) => "Copy it from the Kite menu.".to_string(),
        (None, Some(_), _) => "Open the link from the Kite menu.".to_string(),
        (None, None, _) => return,
    };
    let title = if content { format!("Sign-in from {}", code.service) } else { "Sign-in code ready".to_string() };
    let _ = app.notification().builder().title(title).body(body).show();
}
