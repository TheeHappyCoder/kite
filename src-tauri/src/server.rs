//! The Kite server: `pnpm dev` in debug builds, the bundled Node running server.js (Next standalone-style) in release.

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const ORIGIN: &str = "http://127.0.0.1:3100";
const ADDR: ([u8; 4], u16) = ([127, 0, 0, 1], 3100);

/// The Node child this shell started, killed on exit.
#[derive(Default)]
pub struct Server(pub Mutex<Option<Child>>);

pub fn is_up() -> bool {
    TcpStream::connect_timeout(&ADDR.into(), Duration::from_millis(300)).is_ok()
}

/// Starts the bundled server (release only) unless something already answers on the port.
pub fn start(app: &AppHandle) -> Result<Option<Child>, String> {
    if cfg!(debug_assertions) || is_up() {
        return Ok(None);
    }
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("server");
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command
        .arg("server.js")
        .current_dir(&dir)
        .env("NODE_ENV", "production")
        .env("PORT", ADDR.1.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("KITE_DATA_DIR", data);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map(Some).map_err(|e| e.to_string())
}

pub fn wait_until_up(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if is_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

pub fn stop(app: &AppHandle) {
    if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
