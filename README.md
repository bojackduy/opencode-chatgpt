# opencode-chatgpt

Use **ChatGPT Web** — for free, through your own logged-in session, no API key —
as an OpenCode model, installed with **one line** in your host's plugin config.
No manual JSONC editing, no Go toolchain, no launchd units.

The plugin manages everything: it downloads the
[chatgpt-proxy](https://github.com/bojackduy/chatgpt-proxy) binaries
(`chatgpt-openai` adapter + `chatgpt-proxy` MCP server) from GitHub releases,
injects the provider + MCP config, keeps the adapter and Chrome alive, and
guides first-run login.

## Install

OpenCode v1 (`@opencode-ai/plugin` host):

```jsonc
// opencode.jsonc
{
  "plugin": ["@bojackduy/opencode-chatgpt"]
}
```

With options on current v1 hosts (older v1 schemas support strings only):

```jsonc
{
  "plugin": [["@bojackduy/opencode-chatgpt", { "version": "v0.2.0" }]]
}
```

OpenCode v2 (`@opencode/plugin` host) uses **`plugins`**, not `plugin`:

```jsonc
{
  "plugins": ["@bojackduy/opencode-chatgpt"]
}
```

With options on v2:

```jsonc
{
  "plugins": [{ "package": "@bojackduy/opencode-chatgpt", "options": { "version": "v0.2.0" } }]
}
```

The version option selects a **bridge release**, not the npm package version.
Use an existing bridge tag or omit it for `latest` (examples are not promised releases).

Quit and restart OpenCode after config changes, then select the
`chatgpt-web/chatgpt-web` model in `/models`.

## Host compatibility (v1 + v2, one install)

The same package covers **both** OpenCode generations; use the matching config
syntax above. The host selects `server` (v1) or `setup` (v2):

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
- On v1 the config hook awaits the actual binary path before adding a new MCP
  entry. Failed downloads produce an error, never a placeholder executable.
  Existing manual MCP entries are preserved without waiting for downloads.

## First-run login

1. Restart OpenCode — the plugin downloads the binaries and starts the adapter.
2. On v2 run `/chatgpt-login`; on v1 ask the agent to call `chatgpt-login`: a Chrome window
   using the dedicated profile (`~/.chatgpt-proxy`) opens.
3. Log into ChatGPT there **once** — the session persists in the profile.
4. On v2 re-run `/chatgpt-status`; on v1 ask for `chatgpt-status` until ready.

## Commands

These are slash commands on v2, agent tools on v1. Bundled Markdown templates
in `commands/` can be copied into your v1 `.opencode/commands/` directory if you
want slash-command shortcuts; installing the npm package does not auto-copy them.

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
| macOS   | arm64 + amd64 | arm64 development host; amd64 live unverified | Cross-built assets do not prove every host/architecture works live. |
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

## Publishing (maintainers)

Do not publish from the Go repository. The npm package lives in
`/Users/duytrinh/Code/opencode-chatgpt`.

**Prerequisite:** `bojackduy/chatgpt-proxy` must have its first GitHub release
before another machine can download the bridge. Push bridge `main` through its
`personal` remote, choose an unused `vX.Y.Z` tag, and push that tag through
`personal`. Wait for `Release binaries` to finish and verify **12 binaries**
(two programs × darwin/linux/windows × amd64/arm64) plus `checksums.txt`.
The plugin defaults to `latest`; the release must not be draft or prerelease.

Push plugin `main` to `origin`, then do the **first npm publish manually**, once:

```sh
# Run in /Users/duytrinh/Code/opencode-chatgpt, NOT chatgpt-proxy
npm login
npm publish --access public --provenance=false
```

This runs prepack (typecheck, hermetic tests, build). First publication uses
your npm login without OIDC provenance; do not run the Actions publish workflow
until the package exists and its trusted publisher is configured.

On npmjs.com → `@bojackduy/opencode-chatgpt` → Settings → Trusted Publishers,
add GitHub Actions with owner **`bojackduy`**, repository **`opencode-chatgpt`**,
workflow **`npm-publish.yml`**, and **no environment** (the workflow has none).
No `NPM_TOKEN` is needed. Future releases use:

```sh
bun run release:patch  # or release:minor / release:major
```

These scripts check, bump/commit/tag the npm version, and push the branch and
tag. The tag workflow verifies the version, rejects already published versions,
stops on registry/network/auth errors, verifies prepack, publishes with OIDC
provenance, and creates GitHub release notes. Manual workflow dispatch must
select the matching `v<package-version>` **tag**; branches are rejected.
