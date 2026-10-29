; Kite's installer hooks (tauri.bundle.conf.json). An update installs over the last version: the old
; bundled server (Next build, packages, Node) goes first, so no file from the previous version stays
; behind. The user's data lives elsewhere (%APPDATA%\app.kite.desktop) and is never touched here.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\server"
!macroend

; Explorer's right-click "Show the email in Kite" (src-tauri/src/origin.rs) for every file, this user only.
; On Windows 11 it sits under "Show more options" (the new menu needs a packaged app).
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\*\shell\Kite.ShowEmail" "" "Show the email in Kite"
  WriteRegStr HKCU "Software\Classes\*\shell\Kite.ShowEmail" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\Kite.ShowEmail\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --show-email "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\Kite.ShowEmail"
!macroend
