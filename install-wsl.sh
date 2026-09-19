#!/usr/bin/env bash
# Installs ParcelContext into the WSL remote extension host.
#
# Run from a terminal INSIDE the VS Code WSL window (Terminal > New Terminal).
# The remote CLI needs that window's IPC socket and will refuse to run from a
# plain wsl.exe shell.
set -eu

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSIX="$(ls -1 "$HERE"/parcelcontext-*.vsix 2>/dev/null | sort -V | tail -1)"

if [ -z "${VSIX:-}" ]; then
  echo "No VSIX found in $HERE -- run 'npm run package' first."
  exit 1
fi

if ! command -v code >/dev/null 2>&1; then
  echo "'code' is not on PATH. Open a terminal inside the VS Code WSL window."
  exit 1
fi

echo "installing $(basename "$VSIX")"

# Remove any previous build first. Reinstalling the same version number can be
# treated as a no-op, which leaves stale code running after a reload.
code --uninstall-extension hackathon2026.parcelcontext >/dev/null 2>&1 || true
rm -rf ~/.vscode-server/extensions/hackathon2026.parcelcontext-* 2>/dev/null || true

code --install-extension "$VSIX" --force

echo "--- installed in WSL ---"
code --list-extensions --show-versions | grep -i parcel || true
echo
echo "Now run: Developer: Reload Window"
echo "Then verify with: ParcelContext: Show Version And Diagnostics"