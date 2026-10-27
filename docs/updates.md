# Desktop updates

Release builds check the public GitHub latest release after 20 seconds and every six hours. When a newer signed version exists, the bottom of the outer sidebar shows a download icon. The dialog displays release notes, downloads with byte progress, verifies the signature, and launches the Windows installer, which restarts Kite. Closing the dialog does not cancel an update.

The installer removes the previous bundled `server` directory. User data in the app data directory is preserved. Schema changes should use database migrations, never erase accounts or drafts during an update.

## Publishing a Windows x64 update

1. Publish releases in the public `TheeHappyCoder/kite` repository. The updater deliberately ships no GitHub token.
2. Increment the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json` together.
3. Supply `TAURI_SIGNING_PRIVATE_KEY` and, if needed, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the build environment. Use the original key matching `plugins.updater.pubkey`; keep it backed up outside this repository. Never commit it. Replacing the public key breaks updates for already installed copies.
4. Run `pnpm desktop:build`. Tauri writes the installer and its `.sig` in `src-tauri/target/release/bundle/nsis`.
5. Put release notes in a text/Markdown file, then run:

   ```powershell
   node scripts/update-manifest.mjs src-tauri/target/release/bundle/nsis/Kite_0.2.0_x64-setup.exe release-notes.md v0.2.0
   ```

6. Upload that installer, its `.sig`, and the generated `latest.json` to the same published GitHub release. Mark it as Latest; drafts and prereleases are not the stable update channel. The dialog uses the notes in `latest.json`.
7. Test with an installed older build: check detection, notes, download, restart, new version, and retained accounts/settings. Also test offline downloads and retry. Development builds never install updates.

An older build without the updater needs one manual installation of an updater-enabled version. Subsequent releases can update in-app.
