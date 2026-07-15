#!/bin/sh
set -eu

cat >&2 <<'EOF'
Android production release signing is not configured.
Refusing to copy an unsigned app-release.apk to prebuilts/whitelist-bypass.apk.

For a local development APK:
  cd android-app && ./gradlew assembleDebug

For the persistent-key POC signing/update smoke on the trusted Windows build machine:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\preserve-poc-signing-smoke.ps1

Do not distribute the unsigned release variant.
EOF

exit 1
