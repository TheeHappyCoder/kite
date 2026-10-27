//! The Kite bar: Kite's surface at the top of the screen, a bar floating just below the top edge. One
//! window, made once and kept warm, so showing it costs nothing. The window never resizes (resizing a
//! native window is what makes overlays stutter): it's a fixed, transparent canvas at the top centre,
//! and only the bar inside it animates (the page, /desktop/bar). Clicks pass through the canvas
//! everywhere but the bar: while it's on screen the shell follows the pointer and lets clicks in only
//! over the box the page reports. It never takes focus, so the app you're typing in keeps it, except
//! while you write a quick reply in it: then it takes the keyboard (`focus`) and gives it back to the
//! window you were in when you send or close (`release`). Files dropped on it reach the page as plain
//! HTML drops (Tauri's own drop handler is off).
//!
//! One queue for everything (Kite's codes, meetings and mail, and other apps' activities from the
//! Kite bar API, docs/bar.md): the same id again updates in place, the most important shows
//! first, something urgent steps in front (what was showing waits its turn again), nothing ever
//! lands on a reply being written, and long-lived activities take turns with what's waiting. What
//! waits shows beside it as chips; clicking one brings it forward (`front`).
//!
//! What it shows (an `Item`: a code, a meeting about to start, or mail a rule said to notify about)
//! goes in through `eval` (never the URL); Copy / Open link / Join / Open / Reply, the shape and the
//! reply's keyboard come back via the `bar` command, the only IPC, allowed for this window alone
//! (capabilities/bar.json). The page names a verb, never a value to act on: the shell acts on the
//! item it holds.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::codes::{self, Code};
use crate::server::ORIGIN;

pub const LABEL: &str = "bar";
/// The canvas, in logical pixels: room for the widest bar (an open item plus chips) and the tallest
/// (a quick reply), with its shadow.
const WIDTH: f64 = 980.0;
const HEIGHT: f64 = 400.0;
/// How often the shell checks the pointer against the shape while it's on screen (about 60 Hz).
const TRACK_MS: u64 = 16;

/// A meeting about to start (`DesktopMeeting` in src/lib/desktop.ts).
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub start: String,
    pub end: Option<String>,
    /// The video call link; the server sends https only, and `codes::open` checks again.
    pub join: Option<String>,
    pub place: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Person {
    pub email: String,
    pub name: String,
}

/// New mail a rule said to notify about now (`DesktopMail` in src/lib/desktop.ts).
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mail {
    pub id: String,
    pub account_id: String,
    pub thread_id: String,
    pub from: Person,
    pub subject: String,
    pub preview: Option<String>,
    pub count: u32,
    /// "now" or "batch": only "now" reaches the Kite bar.
    #[serde(skip_serializing)]
    pub notify: String,
}

/// One button on another app's activity (`BarAction` in src/lib/bar/spec.ts).
#[derive(Clone, Deserialize, Serialize)]
pub struct ActivityAction {
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Another app's activity (`BarActivity` in src/lib/bar/spec.ts), validated by the server. The
/// shell reads only what it acts on (copy, open); the rest goes to the page as it came.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub actions: Vec<ActivityAction>,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

/// An integration's activity changed (server/bar/runtime.ts `BarChange`, the `bar` event).
#[derive(Deserialize)]
pub struct Change {
    pub op: String,
    pub activity: Option<Activity>,
    pub id: Option<String>,
}

/// What the Kite bar shows (`BarItem` in src/lib/desktop.ts).
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    Code(Code),
    Meeting(Meeting),
    Mail(Mail),
    Activity(Activity),
}

impl Item {
    fn id(&self) -> &str {
        match self {
            Item::Code(c) => &c.id,
            Item::Meeting(m) => &m.id,
            Item::Mail(m) => &m.id,
            Item::Activity(a) => &a.id,
        }
    }

    /// Codes and meetings can't wait; mail and most activities can; passive ones wait for everything.
    fn rank(&self) -> u8 {
        match self {
            Item::Code(_) | Item::Meeting(_) => 2,
            Item::Mail(_) => 1,
            Item::Activity(a) => match a.priority.as_str() {
                "high" => 2,
                "passive" => 0,
                _ => 1,
            },
        }
    }
}

/// The shape's box inside the canvas, in CSS pixels, as the page last reported it.
#[derive(Clone, Copy, Default, Deserialize)]
pub struct Shape {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Default)]
pub struct Bar {
    /// What the Kite bar shows now.
    item: Mutex<Option<Item>>,
    shape: Mutex<Option<Shape>>,
    /// The page has loaded and can take an item (one that comes before waits for it).
    ready: Mutex<bool>,
    /// Bumped on every show and hide, so only the newest pointer loop keeps running.
    generation: AtomicU64,
    /// Waiting their turn, most important first.
    queue: Mutex<Vec<Item>>,
    /// Quiet (`bar.quiet`): everything arrives as the pill.
    quiet: Mutex<bool>,
    /// A quick reply is open: the Kite bar has the keyboard, and nothing takes its place.
    replying: Mutex<bool>,
    /// The window that had the keyboard before the reply took it (an HWND), to give it back.
    previous: Mutex<Option<isize>>,
}

/// Makes the hidden window once, after the server is up, so the first code shows at once.
pub fn create(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    let Ok(url) = format!("{ORIGIN}/desktop/bar").parse() else { return };
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Kite")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        // Clicking it never activates it: the app you're in keeps the keyboard (paste the code there).
        .focusable(false)
        // Kept out of screenshots and screen shares (it shows codes).
        .content_protected(true)
        // Files dragged from Explorer go to the page as HTML drops (attach to a quick reply).
        .disable_drag_drop_handler()
        .initialization_script("window.__KITE_DESKTOP__ = true;")
        .build();
    match built {
        Ok(window) => {
            let _ = window.set_ignore_cursor_events(true);
        }
        Err(error) => eprintln!("[kite] couldn't make the Kite bar: {error}"),
    }
}

/// Shows an item, updates it in place, or queues it behind what's showing.
pub fn show(app: &AppHandle, item: Item) {
    create(app);
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let state = app.state::<Bar>();
    let mut current = state.item.lock().unwrap();
    let mut queue = state.queue.lock().unwrap();
    // The same one again: an update, wherever it is.
    if current.as_ref().is_some_and(|c| c.id() == item.id()) {
        *current = Some(item.clone());
        drop((current, queue));
        refresh_page(app, &window);
        return;
    }
    if let Some(slot) = queue.iter_mut().find(|q| q.id() == item.id()) {
        *slot = item;
        return;
    }
    let Some(showing) = current.as_ref() else {
        // Nothing on screen: it drops down over the screen you're working on (the pointer's).
        *current = Some(item);
        drop((current, queue));
        place(app, &window);
        refresh_page(app, &window);
        show_quietly(&window);
        track(app.clone());
        return;
    };
    if *state.replying.lock().unwrap() || item.rank() <= showing.rank() {
        let at = queue.iter().position(|q| q.rank() < item.rank()).unwrap_or(queue.len());
        queue.insert(at, item);
    } else {
        // More urgent than what's showing: it steps in front, and that waits its turn again.
        let before = current.replace(item).expect("checked above");
        queue.insert(0, before);
    }
    drop((current, queue));
    refresh_page(app, &window);
}

/// Takes an item away: off the screen (the page lets it leave), or out of the queue.
pub fn remove(app: &AppHandle, id: &str) {
    let state = app.state::<Bar>();
    let Some(window) = app.get_webview_window(LABEL) else { return };
    if state.item.lock().unwrap().as_ref().is_some_and(|c| c.id() == id) {
        if let Ok(id) = serde_json::to_string(id) {
            let _ = window.eval(format!("window.__kiteBarLeave && window.__kiteBarLeave({id});"));
        }
        return;
    }
    state.queue.lock().unwrap().retain(|q| q.id() != id);
    refresh_page(app, &window);
}

pub fn set_quiet(app: &AppHandle, quiet: bool) {
    *app.state::<Bar>().quiet.lock().unwrap() = quiet;
}

/// Whatever comes next, once the page let the current one leave. `again`: it only made way for
/// what's waiting (a long-lived activity), so it goes to the back of the line.
fn next(app: &AppHandle, again: bool) {
    end_reply(app);
    let state = app.state::<Bar>();
    let following = {
        let mut current = state.item.lock().unwrap();
        let mut queue = state.queue.lock().unwrap();
        let finished = current.take();
        if let (true, Some(item)) = (again, finished) {
            queue.push(item);
        }
        let following = if queue.is_empty() { None } else { Some(queue.remove(0)) };
        *current = following.clone();
        following
    };
    let Some(window) = app.get_webview_window(LABEL) else { return };
    if following.is_some() {
        refresh_page(app, &window);
    } else {
        hide(app, &window);
    }
}

/// The window comes up without taking focus (Tauri's show() activates it).
#[cfg(windows)]
fn show_quietly(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    match window.hwnd() {
        Ok(hwnd) => unsafe {
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), SW_SHOWNOACTIVATE);
        },
        Err(_) => {
            let _ = window.show();
        }
    }
}

#[cfg(not(windows))]
fn show_quietly(window: &WebviewWindow) {
    let _ = window.show();
}

/// Lets clicks through the window (or not) by flipping `WS_EX_TRANSPARENT` on it directly. Not Tauri's
/// set_ignore_cursor_events: that re-applies all of its window state, and since `show_quietly` went
/// around Tauri, it still thinks the window is hidden and hides it again the moment the pointer arrives.
#[cfg(windows)]
fn click_through(window: &WebviewWindow, through: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT};
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        // Layered stays on (it was made click-through); only the hit testing changes.
        let flags = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
        let next = if through { style | flags } else { (style & !(WS_EX_TRANSPARENT.0 as isize)) | WS_EX_LAYERED.0 as isize };
        if next != style {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
}

#[cfg(not(windows))]
fn click_through(window: &WebviewWindow, through: bool) {
    let _ = window.set_ignore_cursor_events(through);
}

/// A quick reply: the Kite bar takes the keyboard, remembering who had it. Directly on the window, like
/// `click_through` (Tauri's own calls would hide it again). Allowed by Windows because the click that
/// opened the reply went to this window.
#[cfg(windows)]
fn take_keyboard(app: &AppHandle, window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, SetForegroundWindow, SetWindowLongPtrW, GWL_EXSTYLE,
        WS_EX_NOACTIVATE,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    let state = app.state::<Bar>();
    unsafe {
        let before = GetForegroundWindow();
        if before != hwnd && !before.is_invalid() {
            *state.previous.lock().unwrap() = Some(before.0 as isize);
        }
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !(WS_EX_NOACTIVATE.0 as isize));
        if !SetForegroundWindow(hwnd).as_bool() {
            // Windows refused (the click's permission ran out): borrow the foreground thread's input once.
            let theirs = GetWindowThreadProcessId(before, None);
            let ours = GetCurrentThreadId();
            let _ = AttachThreadInput(ours, theirs, true);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(ours, theirs, false);
        }
    }
}

#[cfg(not(windows))]
fn take_keyboard(_app: &AppHandle, window: &WebviewWindow) {
    let _ = window.set_focusable(true);
    let _ = window.set_focus();
}

/// Back to never taking focus, and the keyboard back to the window that had it.
#[cfg(windows)]
fn give_back_keyboard(app: &AppHandle, window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowLongPtrW, IsWindow, SetForegroundWindow, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    let previous = app.state::<Bar>().previous.lock().unwrap().take();
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize);
        // Only while the Kite bar still has it: if you clicked into another app meanwhile, that one keeps it.
        if let Some(previous) = previous.map(|p| HWND(p as *mut _)) {
            if GetForegroundWindow() == hwnd && IsWindow(Some(previous)).as_bool() {
                let _ = SetForegroundWindow(previous);
            }
        }
    }
}

#[cfg(not(windows))]
fn give_back_keyboard(_app: &AppHandle, window: &WebviewWindow) {
    let _ = window.set_focusable(false);
}

/// Ends a quick reply (sent, closed, or the Kite bar left), then shows whatever waited for it.
fn end_reply(app: &AppHandle) {
    let state = app.state::<Bar>();
    if !std::mem::replace(&mut *state.replying.lock().unwrap(), false) {
        return;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        give_back_keyboard(app, &window);
    }
}

/// Top centre of the pointer's screen, hanging from the top of its work area (below a top taskbar).
fn place(app: &AppHandle, window: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = WIDTH * scale;
    let x = area.position.x as f64 + (area.size.width as f64 - width) / 2.0;
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, area.position.y));
    // After the move, so a screen with another scale gets the same logical size.
    let _ = window.set_size(LogicalSize::new(WIDTH, HEIGHT));
}

/// The page shows the current item (new or updated), with how many wait behind it.
fn refresh_page(app: &AppHandle, window: &WebviewWindow) {
    let state = app.state::<Bar>();
    if !*state.ready.lock().unwrap() {
        return;
    }
    let Some(item) = state.item.lock().unwrap().clone() else { return };
    // What waits, in order, for the chips beside it.
    let context = serde_json::json!({ "waiting": *state.queue.lock().unwrap(), "quiet": *state.quiet.lock().unwrap() });
    let Ok(json) = serde_json::to_string(&item) else { return };
    let _ = window.eval(format!("window.__kiteBar && window.__kiteBar({json}, {context});"));
}

/// While the Kite bar is on screen: clicks go through everywhere but the shape.
fn track(app: AppHandle) {
    let state = app.state::<Bar>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let mut inside = false;
        loop {
            tokio::time::sleep(Duration::from_millis(TRACK_MS)).await;
            let state = app.state::<Bar>();
            if state.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = app.get_webview_window(LABEL) else { return };
            let shape = *state.shape.lock().unwrap();
            let now = match (shape, app.cursor_position(), window.outer_position(), window.scale_factor()) {
                (Some(s), Ok(p), Ok(origin), Ok(scale)) => {
                    let (x, y) = ((p.x - origin.x as f64) / scale, (p.y - origin.y as f64) / scale);
                    x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h
                }
                _ => false,
            };
            if now != inside {
                inside = now;
                click_through(&window, !inside);
            }
        }
    });
}

/// Nothing left to show: the window goes until the next item.
fn hide(app: &AppHandle, window: &WebviewWindow) {
    let state = app.state::<Bar>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.shape.lock().unwrap() = None;
    click_through(window, true);
    let _ = window.hide();
}

/// Called by the Kite bar page. `ready`: it loaded (or reloaded); `shape`: where the shape is now;
/// `hidden`: it finished leaving (`again`: only making way, so back in the queue). Copy, Open and
/// Join act only on a click, on the item the shell holds: `value` is copied only when it's one of
/// the code's own choices, `index` names one of an activity's own buttons.
#[tauri::command]
pub fn bar(app: AppHandle, action: String, value: Option<String>, index: Option<usize>, again: Option<bool>, shape: Option<Shape>, id: Option<String>) {
    let state = app.state::<Bar>();
    let item = state.item.lock().unwrap().clone();
    let button = |activity: &Activity, kind: &str| index.and_then(|i| activity.actions.get(i)).filter(|a| a.kind == kind).cloned();
    match (action.as_str(), item) {
        ("ready", _) => {
            *state.ready.lock().unwrap() = true;
            if let Some(window) = app.get_webview_window(LABEL) {
                refresh_page(&app, &window);
            }
        }
        ("shape", _) => *state.shape.lock().unwrap() = shape,
        ("focus", Some(Item::Mail(_))) => {
            if let Some(window) = app.get_webview_window(LABEL) {
                *state.replying.lock().unwrap() = true;
                take_keyboard(&app, &window);
            }
        }
        ("release", _) => end_reply(&app),
        ("hidden", _) => next(&app, again.unwrap_or(false)),
        ("front", _) => front(&app, id.as_deref()),
        ("copy", Some(Item::Code(code))) if value.is_some() => {
            if code.choices.iter().flatten().any(|c| Some(c) == value.as_ref()) {
                codes::copy(&app, value.as_deref());
            }
        }
        ("copy", Some(Item::Code(code))) => codes::copy(&app, code.code.as_deref()),
        ("fill", Some(Item::Code(code))) => codes::fill(&app, code.code.as_deref()),
        ("open", Some(Item::Code(code))) => codes::open(&app, code.link.as_deref()),
        ("join", Some(Item::Meeting(meeting))) => codes::open(&app, meeting.join.as_deref()),
        ("open", Some(Item::Mail(mail))) => open_mail(&app, &mail, false),
        ("reply", Some(Item::Mail(mail))) => open_mail(&app, &mail, true),
        ("copy", Some(Item::Activity(activity))) => match index {
            Some(_) => codes::copy(&app, button(&activity, "copy").and_then(|b| b.text).as_deref()),
            // Without a button: the activity's code value.
            None => {
                let code = activity.value.as_ref().filter(|v| v["type"] == "code").and_then(|v| v["code"].as_str());
                codes::copy(&app, code);
            }
        },
        ("open", Some(Item::Activity(activity))) => codes::open(&app, button(&activity, "open_url").and_then(|b| b.url).as_deref()),
        _ => {}
    }
}

/// A chip was clicked: that item comes forward, and what was showing waits first in line. Never over a
/// reply being written.
fn front(app: &AppHandle, id: Option<&str>) {
    let state = app.state::<Bar>();
    let Some(id) = id else { return };
    if *state.replying.lock().unwrap() {
        return;
    }
    {
        let mut current = state.item.lock().unwrap();
        let mut queue = state.queue.lock().unwrap();
        let Some(at) = queue.iter().position(|q| q.id() == id) else { return };
        let chosen = queue.remove(at);
        if let Some(before) = current.replace(chosen) {
            queue.insert(0, before);
        }
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        refresh_page(app, &window);
    }
}

/// Brings Kite forward on the conversation (mail-app's `__kiteOpenMail`), with a reply open if asked.
fn open_mail(app: &AppHandle, mail: &Mail, reply: bool) {
    crate::show(app);
    let Some(main) = app.get_webview_window("main") else { return };
    let target = serde_json::json!({ "threadId": mail.thread_id, "accountId": mail.account_id, "subject": mail.subject, "reply": reply });
    let _ = main.eval(format!("window.__kiteOpenMail && window.__kiteOpenMail({target});"));
}
