#!/bin/bash
# Starts the Nib server with its secrets (.env) on port 8899. Used by the launchd agent com.nib.server.
cd "$(dirname "$0")" || exit 1
set -a; . ./.env; set +a
export PORT=8899
exec /usr/local/bin/node server/server.js 2>&1 || exec node server/server.js
