//! Print to Kite: a printer called "Kite" in every app's Print window. It is Windows' own
//! "Microsoft Print To PDF" driver writing to a file port in Kite's folder; Kite watches that file,
//! uploads each finished print the way compose does and the page opens a new message with the PDF
//! (`__kitePrinted`, components/mail/mail-app.tsx). Nothing is sent by itself.
//!
//! Adding or removing a printer needs an administrator, so it happens only when the user switches it
//! on or off in Settings → Files (the `printer` command), behind Windows' own permission prompt, and
//! the uninstaller removes it (`--remove-printer`, installer-hooks.nsh).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const NAME: &str = "Kite";
const DRIVER: &str = "Microsoft Print To PDF";

#[derive(Serialize, Clone, Default)]
pub struct PrinterState {
    /// The Kite printer is there and prints into Kite.
    on: bool,
    /// Windows can't have it here (not Windows, or no Print To PDF driver).
    unavailable: bool,
    /// Why the last change didn't happen, in plain words.
    error: Option<String>,
}

/// %LOCALAPPDATA%\app.kite.desktop\print: the same for the dev and release apps (one printer per user).
fn folder() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("app.kite.desktop").join("print"))
}

/// The printer's port: the one file every print is written to.
fn port() -> Option<PathBuf> {
    folder().map(|f| f.join("printed.pdf"))
}

#[tauri::command]
pub async fn printer(action: String) -> PrinterState {
    tauri::async_runtime::spawn_blocking(move || {
        let error = match action.as_str() {
            "on" => change(true).err(),
            "off" => change(false).err(),
            _ => None,
        };
        PrinterState { error, ..state() }
    })
    .await
    .unwrap_or_default()
}

/// Run by the uninstaller: removes the printer if it's there (one permission prompt), else does nothing.
pub fn uninstall() {
    if state().on {
        let _ = change(false);
    }
}

#[cfg(windows)]
fn state() -> PrinterState {
    let Some(port) = port() else { return PrinterState { unavailable: true, ..Default::default() } };
    let script = format!(
        "$p = Get-Printer -Name '{NAME}' -ErrorAction SilentlyContinue; $d = Get-PrinterDriver -Name '{DRIVER}' -ErrorAction SilentlyContinue; \"$([bool]$d)|$($p.PortName)\""
    );
    let out = powershell(&script).unwrap_or_default();
    let (driver, current) = out.trim().split_once('|').unwrap_or(("False", ""));
    PrinterState {
        on: Path::new(current) == port,
        unavailable: driver != "True",
        error: (!current.is_empty() && Path::new(current) != port).then(|| "There's already a printer called Kite that isn't this one.".into()),
    }
}

#[cfg(not(windows))]
fn state() -> PrinterState {
    PrinterState { unavailable: true, ..Default::default() }
}

/// Adds or removes the printer and its port, as an administrator (Windows asks first).
#[cfg(windows)]
fn change(on: bool) -> Result<(), String> {
    let folder = folder().ok_or("Kite can't find your user folder.")?;
    let port = port().ok_or("Kite can't find your user folder.")?;
    let port = port.to_string_lossy().replace('\'', "''");
    let script = if on {
        std::fs::create_dir_all(&folder).map_err(|_| "Kite couldn't make its print folder.".to_string())?;
        format!(
            "$ErrorActionPreference = 'Stop'\n\
             if (-not (Get-PrinterPort -Name '{port}' -ErrorAction SilentlyContinue)) {{ Add-PrinterPort -Name '{port}' }}\n\
             if (-not (Get-Printer -Name '{NAME}' -ErrorAction SilentlyContinue)) {{ Add-Printer -Name '{NAME}' -DriverName '{DRIVER}' -PortName '{port}' }}"
        )
    } else {
        format!(
            "Remove-Printer -Name '{NAME}' -ErrorAction SilentlyContinue\n\
             Start-Sleep -Milliseconds 500\n\
             Remove-PrinterPort -Name '{port}' -ErrorAction SilentlyContinue"
        )
    };
    // One elevated PowerShell for the whole change: Windows' permission prompt shows once.
    let outer = format!(
        "try {{ $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{}'; exit $p.ExitCode }} catch {{ exit 1223 }}",
        encode_command(&script)
    );
    match powershell_status(&outer) {
        Some(0) => Ok(()),
        Some(1223) => Err("Windows didn't give Kite permission, so nothing changed.".into()),
        _ if on => Err("Windows couldn't add the printer. Try again, or check that “Microsoft Print to PDF” is turned on in Windows features.".into()),
        _ => Err("Windows couldn't remove the printer. Try again in a moment.".into()),
    }
}

#[cfg(not(windows))]
fn change(_on: bool) -> Result<(), String> {
    Err("Printing to Kite works on Windows only.".into())
}

#[cfg(windows)]
fn command(script: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]).creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn powershell(script: &str) -> Option<String> {
    let out = command(script).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn powershell_status(script: &str) -> Option<i32> {
    command(script).status().ok()?.code()
}

/// PowerShell's -EncodedCommand: the script as UTF-16LE in base64 (no quoting to get wrong).
#[cfg(windows)]
fn encode_command(script: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Watching for prints
// ---------------------------------------------------------------------------

/// Watches the port file: once a print is finished (Windows lets go of the file and its size holds),
/// it's moved aside at once (the next print may follow) and handed to the page.
pub fn start(app: &AppHandle) {
    let (Some(folder), Some(port)) = (folder(), port()) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let mut size = None;
        let mut title: Option<Option<String>> = None;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let Ok(meta) = port.metadata() else {
                size = None;
                title = None;
                continue;
            };
            // The document's name, asked while Windows still lists the print job.
            if title.is_none() {
                title = Some(job_name());
            }
            let now = meta.len();
            let settled = now > 0 && size == Some(now) && released(&port);
            size = Some(now);
            if !settled {
                continue;
            }
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let job = folder.join(format!("job-{stamp}.pdf"));
            let name = file_name(title.take().flatten());
            size = None;
            if std::fs::rename(&port, &job).is_ok() {
                let app = app.clone();
                std::thread::spawn(move || hand_over(&app, &job, &name));
            }
        }
    });
}

fn hand_over(app: &AppHandle, job: &Path, name: &str) {
    let payload = match tauri::async_runtime::block_on(crate::origin::upload_named(job, name)) {
        Ok(upload) => {
            // The server keeps its own copy for the message.
            let _ = std::fs::remove_file(job);
            serde_json::json!({ "attach": upload })
        }
        Err(error) => serde_json::json!({ "error": format!("{error} The PDF is in {}.", job.parent().map(|p| p.display().to_string()).unwrap_or_default()) }),
    };
    crate::origin::call_page(app, "__kitePrinted", &payload.to_string());
}

/// True once nothing else has the file open (the driver has finished writing it).
#[cfg(windows)]
fn released(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).share_mode(0).open(path).is_ok()
}

#[cfg(not(windows))]
fn released(_path: &Path) -> bool {
    true
}

/// The document name of the print job Windows is running on the Kite printer, if it still lists one.
#[cfg(windows)]
fn job_name() -> Option<String> {
    let name = powershell(&format!("Get-PrintJob -PrinterName '{NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty DocumentName"))?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(not(windows))]
fn job_name() -> Option<String> {
    None
}

/// Document extensions dropped from a job's name ("Invoice 42.docx" -> "Invoice 42.pdf").
const EXTENSIONS: &[&str] = &["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "pdf", "htm", "html", "png", "jpg", "jpeg"];

/// "Microsoft Word - Invoice 42.docx" -> "Invoice 42.pdf"; a browser's page title stays whole; no name ->
/// "Printed from Windows.pdf".
fn file_name(title: Option<String>) -> String {
    let stem = title
        .map(|t| {
            let t = t.split_once(" - ").filter(|(app, _)| app.starts_with("Microsoft ")).map_or(t.as_str(), |(_, doc)| doc);
            let t = match t.rsplit_once('.') {
                Some((stem, ext)) if !stem.is_empty() && EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) => stem,
                _ => t,
            };
            let safe: String = t.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c }).collect();
            safe.trim().chars().take(120).collect::<String>()
        })
        .filter(|s| !s.is_empty());
    format!("{}.pdf", stem.unwrap_or_else(|| "Printed from Windows".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_print_after_its_document() {
        assert_eq!(file_name(Some("Microsoft Word - Invoice 42.docx".into())), "Invoice 42.pdf");
        assert_eq!(file_name(Some("Q3 report.xlsx".into())), "Q3 report.pdf");
        assert_eq!(file_name(Some("Order #123: Acme / Shop".into())), "Order #123  Acme   Shop.pdf");
        assert_eq!(file_name(Some("example.com".into())), "example.com.pdf");
        assert_eq!(file_name(Some("   ".into())), "Printed from Windows.pdf");
        assert_eq!(file_name(None), "Printed from Windows.pdf");
    }

    #[cfg(windows)]
    #[test]
    fn encodes_scripts_for_powershell() {
        // "ab" as UTF-16LE is 61 00 62 00.
        assert_eq!(encode_command("ab"), "YQBiAA==");
        assert_eq!(encode_command("a"), "YQA=");
    }
}
