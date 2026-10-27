//! Tray icon: left click shows Kite; the menu lists fresh codes and links, then Show and Quit.

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::codes::{self, Code};

pub const ID: &str = "kite";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip("Kite")
        .menu(&menu(app, &[])?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => crate::show(app),
            "quit" => app.exit(0),
            id => codes::act(app, id),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn update(app: &AppHandle, codes: &[Code]) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(ID), menu(app, codes)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn menu(app: &AppHandle, codes: &[Code]) -> tauri::Result<Menu<Wry>> {
    // "&" marks a mnemonic in Windows menus.
    let name = |service: &str| service.replace('&', "&&");
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for code in codes {
        // The code itself never goes in the menu (it shows on shared screens); Copy puts it on the clipboard.
        if code.needs_pick() {
            let label = format!("Pick code · {}", name(&code.service));
            items.push(Box::new(MenuItem::with_id(app, format!("pick:{}", code.id), label, true, None::<&str>)?));
        }
        if code.code.is_some() {
            let label = format!("Copy code · {}", name(&code.service));
            items.push(Box::new(MenuItem::with_id(app, format!("copy:{}", code.id), label, true, None::<&str>)?));
        }
        if code.link.is_some() {
            let label = format!("Open link · {}", name(&code.service));
            items.push(Box::new(MenuItem::with_id(app, format!("open:{}", code.id), label, true, None::<&str>)?));
        }
    }
    if items.is_empty() {
        items.push(Box::new(MenuItem::with_id(app, "none", "No recent codes", false, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(app, "show", "Show Kite", true, None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "quit", "Quit Kite", true, None::<&str>)?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &refs)
}
