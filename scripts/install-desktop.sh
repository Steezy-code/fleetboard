#!/usr/bin/env bash
# Add Fleetboard to the app launcher (~/.local/share/applications).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/fleetboard.desktop <<DESKTOP
[Desktop Entry]
Name=Fleetboard
Comment=A visual board of real terminals for your AI coding agents
Exec=$root/bin/fleetboard
Icon=$root/resources/icon.png
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=Fleetboard
DESKTOP
echo "Installed ~/.local/share/applications/fleetboard.desktop"
