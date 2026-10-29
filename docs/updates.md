# Desktop updates

Release builds check the public GitHub latest release after 20 seconds and every hour (one ~1 KB `latest.json`). When a newer signed version exists, the foot of the rail shows an update icon with a lime dot that pings every few seconds. The dialog (a strip of the sky with Kite on its string) shows the release notes (`- ` lines as a list), then the download, the signature check, the install and the restart as steps with byte progress; verifies the signature, and launches the Windows installer, which restarts Kite. Closing the dialog does not cancel an update.

The installer removes the previous bundled `server` directory. User data in the app data directory is preserved. Schema changes should use database migrations, never erase accounts or drafts during an update.

Settings → Privacy → Check for updates turns the timed checks off; Settings → About's Check for updates still works.

## Publishing a Windows x64 update

Releases are built by GitHub Actions (`.github/workflows/release.yml`), never on a personal computer, so each one traces back to this repository (SignPath Foundation's rule for free signing, CODE_SIGNING.md).

1. Increment the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json` together, and commit.
2. Tag it with the release notes as the tag message and push the tag:

   ```powershell
   git tag -a v0.2.1 -m "What changed, in a few lines"
   git push origin v0.2.1
   ```

3. The workflow checks the tag matches the version, builds `kite.exe`, has SignPath sign it, makes the installer around the signed exe, has SignPath sign the installer, signs it for the updater, writes `latest.json`, and drafts the GitHub release with the installer, its `.sig`, `latest.json` and `Kite-Setup.exe` (the site's Download button). Each SignPath step waits for you to approve it in SignPath (up to two hours).
4. Look over the draft release and publish it as Latest. Installed copies update from the published Latest release only; drafts and prereleases are never offered.
5. Test with an installed older build: check detection, notes, download, restart, new version, and retained accounts/settings. Also test offline downloads and retry. Development builds never install updates.

The workflow reads these repository secrets: `MICROSOFT_CLIENT_ID`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the original key matching `plugins.updater.pubkey`; keep it backed up outside this repository, never commit it: replacing the public key breaks updates for every installed copy), and `SIGNPATH_API_TOKEN`. Signing runs once the repository variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_POLICY_SLUG` are set; until then the workflow builds an unsigned release the same way. The SignPath project needs two artifact configurations, `kite-exe` and `kite-installer`, copied from `.signpath/artifact-configurations/`.

`pnpm desktop:build` still makes a local build for testing; don't publish one.

An older build without the updater needs one manual installation of an updater-enabled version. Subsequent releases can update in-app.
