#!/bin/bash
# Wrapper for launchd — sources .env so secrets stay in one file
set -a
source "$(dirname "$0")/../.env"
set +a
exec /Users/hmps/.local/share/mise/installs/node/24.11.1/bin/node "$(dirname "$0")/../dist/index.js"
