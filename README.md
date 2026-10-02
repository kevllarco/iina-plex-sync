# IINA Plex Sync

Open-source [IINA](https://iina.io) plugin that scrobbles **local** playback to **your** Plex account.

- Sign in with Plex (browser PIN login — no token pasting)
- Pick your server (prefers a reachable connection from Plex resources)
- While you watch in IINA: progress updates On Deck / resume
- At **90%** (configurable): mark watched via Plex `/:/scrobble`
- Matches files by **basename + path tail (+ size when known)** — never title search
- Sticky HUD (drag / corner snap); toggle HUD with **⌃⇧P**, pause sync with **⌃⇧S**

## Requirements

- IINA 1.4+ recommended (1.3.2+ minimum)
- A Plex account with access to a Plex Media Server
- Network access to `plex.tv` and your server

## Install (end users)

1. Download the latest `.iinaplgz` from [Releases](https://github.com/kevllarco/iina-plex-sync/releases)
2. Open the file (or **Settings → Plugins → Install from file…**)
3. Enable **IINA Plex Sync**, then restart IINA if prompted

## Install (development)

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link /path/to/iina-plex-sync
```

Creates a `.iinaplugin-dev` symlink under `~/Library/Application Support/com.colliderli.iina/plugins/`. Restart IINA and enable the plugin.

## Use

1. **Settings → Plugins → IINA Plex Sync → Preferences** → **Sign in with Plex** (or **Plugin → IINA Plex Sync**)
2. Complete login in the browser
3. Play a **local** library file — HUD shows ACTIVE when matched
4. Optional: **Refresh Library Index** from the Plugin menu after big library changes

### Shortcuts

| Shortcut | Action |
|----------|--------|
| **⌃⇧S** | Pause / resume Plex sync (no timeline or watched marks while paused) |
| **⌃⇧P** | Show / hide the sync HUD |

Same actions are in **Plugin → IINA Plex Sync**. Prefs also has **Sync playback to Plex** and **Show sync status overlay**.

## How matching works

File-based only — never title/hub search.

1. Library index maps `basename → { ratingKey, size?, path suffix }` (Movie + TV episode parts)
2. On play, look up the current file’s basename; verify against Plex metadata (path tail + byte size when known)
3. If missing/stale: Plex `/library/all?file=<basename>`, keep only hits whose `Part.file` basename matches, disambiguate with shared path suffix + `file-size`
4. Zero or multiple confident matches → skip (never guess)

Mount prefixes may differ (`/Volumes/…` vs `/volume1/…`); matching uses the shared path tail, not the full absolute path.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| **NO MATCH** | Filename must exist as a Plex `Part.file` basename. Remux/rename breaks match until you refresh the index. Duplicate basenames are skipped on purpose. |
| Sync does nothing | Check **⌃⇧S** / prefs **Sync playback to Plex**. Confirm you’re signed in and the correct server is selected. |
| HTTP/HTTPS streams | Ignored — only local `file://` / disk paths are scrobbled. |
| Stale matches after library edits | **Plugin → Refresh Library Index**. |
| HUD missing | **⌃⇧P** or prefs overlay checkbox. |

## Privacy

- Primary access token prefers **Keychain**; if Keychain write fails it falls back to plugin preferences (prefs shows a note).
- Server list in preferences may include **per-server access tokens** (Plex resources payload) so the plugin can talk to your PMS.
- Network permission is `allowedDomains: ["*"]` because PMS hosts are often `*.plex.direct` (and custom hosts). In practice the plugin only calls `plex.tv` / `app.plex.tv` for login and the server URI you select for library/timeline/scrobble.
- Tokens never leave your Mac except as `X-Plex-Token` to those hosts.

## Pack for sharing

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin pack /path/to/iina-plex-sync
```

Produces a `.iinaplgz`. Releases set `ghRepo` / `ghVersion` in `Info.json` for IINA’s GitHub update check.

## License

MIT — see [LICENSE](./LICENSE).
