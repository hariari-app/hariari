#!/bin/bash
# Post-install script for .deb package
# Sets SUID bit on chrome-sandbox so Electron can use the sandbox
chown root:root /opt/VibeIDE/chrome-sandbox 2>/dev/null || true
chmod 4755 /opt/VibeIDE/chrome-sandbox 2>/dev/null || true
