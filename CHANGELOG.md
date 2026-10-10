# Changelog

## 0.1.0 — Initial scaffold

- One-line install: `plugin` array entry injects the `chatgpt-web` provider + `chatgpt` MCP via the `config` hook (fill-missing only, never clobbers).
- Managed binaries: downloads `chatgpt-openai` + `chatgpt-proxy` from GitHub releases into a versioned cache dir with sha256 verification.
- Supervisor: keeps the adapter listening and Chrome CDP answering while the plugin lives.
- Commands: `/chatgpt-status`, `/chatgpt-login`, `/chatgpt-doctor`.
