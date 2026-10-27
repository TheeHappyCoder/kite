; Kite's installer hooks (tauri.bundle.conf.json). An update installs over the last version: the old
; bundled server (Next build, packages, Node) goes first, so no file from the previous version stays
; behind. The user's data lives elsewhere (%APPDATA%\app.kite.desktop) and is never touched here.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\server"
!macroend
