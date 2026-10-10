---
description: Launch the profile Chrome window for one-time ChatGPT login, then re-probe readiness.
---

Log into the ChatGPT Web bridge using the `chatgpt-login` tool.

Run the tool: it launches Chrome with the dedicated profile and re-probes
the adapter. Tell the user to log into ChatGPT in that window ONCE — the
session persists in the profile dir and is reused forever. Then ask them to
re-run `/chatgpt-status` to confirm readiness.
