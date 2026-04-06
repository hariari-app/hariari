#!/bin/bash
# Post-install script for .deb package
# chrome-sandbox is removed at build time (see after-pack.js) so
# Chromium uses the user namespace sandbox instead of the SUID sandbox.
# No SUID setup is needed.
