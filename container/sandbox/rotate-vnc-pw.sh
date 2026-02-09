#!/bin/bash
# Rotate VNC password: update the password file and restart x11vnc.
# Usage: /rotate-vnc-pw.sh <new-password>
# Drops existing VNC connections (intentional for security).
set -e

NEW_PW="${1:?Usage: rotate-vnc-pw.sh <new-password>}"
PASSWD_FILE="/tmp/vncpasswd"

# Write the new password in x11vnc's rfbauth format
x11vnc -storepasswd "$NEW_PW" "$PASSWD_FILE" 2>/dev/null

# Restart x11vnc so it picks up the new password file.
# pkill sends SIGTERM; the process is restarted below.
pkill -x x11vnc 2>/dev/null || true
sleep 0.3

# Relaunch x11vnc with the updated password
x11vnc -display :99 -forever -shared -rfbport 5900 -rfbauth "$PASSWD_FILE" &
disown

echo "VNC password rotated"
