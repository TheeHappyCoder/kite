fn main() {
    // The Kite bar page is served from 127.0.0.1:3100, which a release build treats as a remote origin:
    // remote pages may only call app commands declared here and allowed in a capability
    // (`allow-bar` in capabilities/bar.json, `allow-update` and `allow-printer` in main.json). Dev's devUrl counts as local.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["bar", "update", "printer"])))
        .expect("failed to run tauri-build");
}
