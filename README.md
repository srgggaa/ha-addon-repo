## Adding this repo to Home Assistant
1. Push this whole folder (as-is, with `repository.yaml` at the root) to a
   GitHub repo.
2. In HA: **Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories**,
   paste your repo URL, click **Add**.
3. Refresh the store page. **"VRChat Friend Notifier"** should appear under
   Local/your repo's add-ons.
4. Click it → **Install**.
5. Go to the **Configuration** tab and fill in:
   - `discord_token`, `discord_client_id` (from the Discord Developer Portal)
   - `owner_discord_id` (your own Discord user ID)
   - `vrchat_username`, `vrchat_password`
6. **Start** the add-on. On first start it'll ask for a 2FA code — check the
   add-on's **Log** tab, and note that with this add-on there's currently no
   way to type a response back into it (see note below).
7. On the **Info** tab, enable **Start on boot**.

## ⚠️ 2FA note
`session.js` uses Node's `readline` to prompt for a 2FA code interactively,
which won't work inside a headless add-on container (no stdin attached).
**Do the very first login on your PC** (as you've already been doing) so a
`session.json` gets generated locally, then copy that file directly into
the add-on's config share — `\\<your-ha-ip>\addon_configs\<addon-slug>\session.json`
(the same folder you can browse over Samba/SSH; no subfolder needed) —
**before** first starting the add-on. That lets it skip straight to
"Reusing saved session" and avoid needing 2FA input inside the container.
If the session ever fully expires, repeat this: log in once on your PC,
copy the fresh `session.json` over.

## Folder structure
```
repository.yaml          <- tells HA this is an add-on repo
vrc-notifier/
  config.yaml             <- add-on metadata + options schema (shows up as UI form)
  build.yaml              <- base image per architecture
  Dockerfile
  run.sh                  <- reads options.json -> env vars, then starts the bot
  bot.js, session.js, store.js, vrchat.js, package.json, data.json
```
