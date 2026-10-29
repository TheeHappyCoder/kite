; Kite's installer hooks (tauri.bundle.conf.json). An update installs over the last version: the old
; bundled server (Next build, packages, Node) goes first, so no file from the previous version stays
; behind. The user's data lives elsewhere (%APPDATA%\app.kite.desktop) and is never touched here.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\server"
!macroend

; Explorer's right-click "Show the email in Kite" and "Send back in Kite" (src-tauri/src/origin.rs)
; for every file, this user only. On Windows 11 they sit under "Show more options" (the new menu needs
; a packaged app). The key names match what a dev setup registers, so installing replaces those.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\*\shell\KiteShowEmail" "" "Show the email in Kite"
  WriteRegStr HKCU "Software\Classes\*\shell\KiteShowEmail" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\KiteShowEmail\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --show-email "%1"'
  WriteRegStr HKCU "Software\Classes\*\shell\KiteSendBack" "" "Send back in Kite"
  WriteRegStr HKCU "Software\Classes\*\shell\KiteSendBack" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\KiteSendBack\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --send-back "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\KiteShowEmail"
  DeleteRegKey HKCU "Software\Classes\*\shell\KiteSendBack"
!macroend
