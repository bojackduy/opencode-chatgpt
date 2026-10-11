# Changelog

## 0.1.0 — Initial scaffold

- Hermetic login-command tests: no real Chrome launch or adapter probes during prepack.
- v1 first-install MCP registration waits for binary resolution instead of storing a placeholder command.
- CI and tag-driven npm trusted publishing with provenance; first publication remains manual.
- Host-specific install syntax documented for v1 (`plugin`) and v2 (`plugins`).
- One-line install: `plugin` array entry injects the `chatgpt-web` provider + `chatgpt` MCP via the `config` hook (fill-missing only, never clobbers).
- Managed binaries: downloads `chatgpt-openai` + `chatgpt-proxy` from GitHub releases into a versioned cache dir with sha256 verification.
- Supervisor: keeps the adapter listening and Chrome CDP answering while the plugin lives.
- Commands: `/chatgpt-status`, `/chatgpt-login`, `/chatgpt-doctor`.
