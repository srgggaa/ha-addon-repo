#!/usr/bin/with-contenv sh
set -e

OPTIONS_FILE="/data/options.json"

export DISCORD_TOKEN="$(jq -r '.discord_token' "$OPTIONS_FILE")"
export DISCORD_CLIENT_ID="$(jq -r '.discord_client_id' "$OPTIONS_FILE")"
export OWNER_DISCORD_ID="$(jq -r '.owner_discord_id' "$OPTIONS_FILE")"
export VRCHAT_USERNAME="$(jq -r '.vrchat_username' "$OPTIONS_FILE")"
export VRCHAT_PASSWORD="$(jq -r '.vrchat_password' "$OPTIONS_FILE")"

# Persist watched-friends list and the VRChat session cookie across
# add-on restarts/updates by keeping them in the mapped /addon_config volume
# (config.yaml maps addon_config:rw) instead of the container's writable layer.
PERSIST_DIR="/addon_config/vrc-notifier"
mkdir -p "$PERSIST_DIR"

if [ -f "$PERSIST_DIR/data.json" ]; then
  cp "$PERSIST_DIR/data.json" /app/data.json
fi
if [ -f "$PERSIST_DIR/session.json" ]; then
  cp "$PERSIST_DIR/session.json" /app/session.json
fi

# Symlink app's data files to the persisted copies so writes go straight there
ln -sf "$PERSIST_DIR/data.json" /app/data.json
ln -sf "$PERSIST_DIR/session.json" /app/session.json

cd /app
exec node bot.js
