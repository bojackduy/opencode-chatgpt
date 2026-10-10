# opencode-chatgpt

Use **ChatGPT Web** — for free, through your own logged-in session, no API key —
as an OpenCode model, installed with **one line** in your `plugin` array.
No manual JSONC editing, no Go toolchain, no launchd units.

The plugin manages everything: it downloads the
[chatgpt-proxy](https://github.com/bojackduy/chatgpt-proxy) binaries
(`chatgpt-openai` adapter + `chatgpt-proxy` MCP server) from GitHub releases,
injects the provider + MCP config, keeps the adapter and Chrome alive, and
guides first-run login.

## Install

```jsonc
// opencode.jsonc
{
  "plugin": ["@bojackduy/opencode-chatgpt"]
}
```

With options:

```jsonc
{
  "plugin": [["@bojackduy/opencode-chatgpt", { "version": "v0.2.0" }]]
}
```

Quit and restart OpenCode after config changes, then select the
`chatgpt-web/chatgpt-web` model in `/models`.

## Host compatibility (v1 + v2, one install)

The single install line above covers **both** OpenCode generations — the
plugin detects its host and registers through the matching API:

| Host | Mechanism | Provider | MCP | Commands |
| ---- | --------- | -------- | --- | -------- |
| OpenCode v1 | `server` + `config` hook (fill-missing-only) + `tool` map | `provider.chatgpt-web` injected | `mcp.chatgpt` injected | agent tools `chatgpt-status` / `chatgpt-login` / `chatgpt-doctor` |
| OpenCode v2 | `setup` + domain transforms (fill-missing-only) | `ctx.provider.transform` — same id, model, modalities, limits | `ctx.mcp.transform` — same name, same proxy command | slash commands `/chatgpt-status` / `/chatgpt-login` / `/chatgpt-doctor` (report posted back into the session) |

Notes:

- v2 needs **no config hook** — providers, MCP servers, and commands are
  first-class domains, so there is nothing to inject into.
- Both paths share one managed-binary lifecycle per process (whichever host
  loads wins — the supervisor never double-spawns) and the same
  never-clobber rule: pre-existing `chatgpt-web` / `chatgpt` entries are
  left untouched.
- On v2 the MCP entry registers the exact cache path up front and reloads
  once the background download lands, so no restart is needed.

## First-run login

1. Restart OpenCode — the plugin downloads the binaries and starts the adapter.
2. Run `/chatgpt-login` (or wait for the first-run notice): a Chrome window
   using the dedicated profile (`~/.chatgpt-proxy`) opens.
3. Log into ChatGPT there **once** — the session persists in the profile.
4. Re-run `/chatgpt-status` until it reports ready.

## Commands

| Command           | What it does                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `/chatgpt-status` | ready / login / binary versions                                           |
| `/chatgpt-login`  | launch the profile Chrome window for one-time login, then re-probe        |
| `/chatgpt-doctor` | binary present+executable, port open, Chrome answering, login state, adapter version — each with repair hints |

## Options

| Option             | Default                  | Meaning                                                        |
| ------------------ | ------------------------ | -------------------------------------------------------------- |
| `releasesRepo`     | `bojackduy/chatgpt-proxy`| GitHub repo to download bridge binaries from (retarget forks)  |
| `version`          | `latest`                 | Release tag to download, or `latest`                           |
| `profileDir`       | `~/.chatgpt-proxy`       | Chrome profile dir holding the ChatGPT login                   |
| `cdpPort`          | `9222`                   | Chrome remote-debugging port                                   |
| `adapterAddr`      | `127.0.0.1:8788`         | Adapter listen address (`-addr`)                               |
| `maxChars`         | `200000`                 | Per-turn paste budget passed to the adapter (`-max-chars`)     |
| `projectPerSession`| `false`                  | Set `CHATGPT_BRIDGE_PROJECT_PER_SESSION=1` for the adapter     |

Binaries land in `~/.local/share/opencode-chatgpt/<version>/` on macOS/Linux
(`%LOCALAPPDATA%\opencode-chatgpt\<version>\` on Windows);
logs in `~/.local/share/opencode-chatgpt/logs/`.

## Platform support

| OS      | Arch          | Status | Notes |
| ------- | ------------- | ------ | ----- |
| macOS   | arm64 + amd64 | ✅ verified live | Primary dev platform. |
| Linux   | amd64 + arm64 | ⚠️ built, paths covered, no live run yet | Chrome lookup covers distro packages (`/usr/bin`), `/opt` bundles, `/usr/local`, snap (`/snap/bin`), and `~/.local/bin`; cache follows XDG (`~/.local/share`). Set `CHROME_BIN` if your browser lives elsewhere. No live end-to-end run yet — please report yours. |
| Windows | amd64 + arm64 | 🧪 beta — cross-compiled + unit-tested, needs a live volunteer | See Windows notes below. |

Release assets: `chatgpt-openai-<goos>-<goarch>` / `chatgpt-proxy-<goos>-<goarch>`
(plus `.exe` on Windows) with `checksums.txt`, built from `ubuntu-latest`
via `GOOS=`/`GOARCH=` cross-compilation — no Windows runner involved.

### Windows notes (beta)

- **Install is identical**: add the plugin line, restart OpenCode, run
  `/chatgpt-login`. The first-run login flow is the same Chrome profile window.
- **SmartScreen**: the bridge binaries are unsigned, so Windows SmartScreen may
  warn on first download — choose "Run anyway" (details / more info). Binaries
  are sha256-verified against the release `checksums.txt` before first run.
- **Chrome lookup**: `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, then the per-user
  `%LOCALAPPDATA%` install, in that order — or set `CHROME_BIN` to any path.
- **Profile dir** defaults to `%USERPROFILE%\.chatgpt-proxy` (same `~` default,
  resolved via `os.homedir()`).
- **Known limitations**: process cleanup kills the supervised child only (no
  POSIX process-group kill — unavailable on Windows); no Windows service /
  autostart integration — the plugin supervisor manages the processes while
  OpenCode runs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Binaries still downloading` | Wait a few seconds and retry — first start downloads ~2 binaries. |
| `NOT READY: not logged in` | `/chatgpt-login`, log in once in the profile window, `/chatgpt-status`. |
| `CDP not answering` | `/chatgpt-login` relaunches the profile Chrome. |
| `checksum mismatch` | Delete the versioned cache dir above and restart opencode. |
| `unsupported platform` | Prebuilt binaries cover darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, windows-amd64, windows-arm64. Build chatgpt-proxy from source and point `releasesRepo` at your fork. |

This uses your personal ChatGPT session (subject to its usage limits).
