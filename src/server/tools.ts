// Tool implementations for the chatgpt-* commands.
// Probe helpers take explicit parameters so they stay testable without a
// live browser.

import * as fs from "node:fs"
import { spawn } from "node:child_process"
import type { ResolvedOptions } from "./options"
import { cacheDir } from "./binaries"
import {
  findChromeBinary,
  httpGet,
  probeChromeCDP,
  probeReadiness,
  tcpProbe,
  describeError,
} from "./supervisor"

export interface DoctorLine {
  name: string
  ok: boolean
  detail: string
  hint?: string
}

export async function statusReport(
  opts: ResolvedOptions,
  binaries: { openai: string; proxy: string; version: string },
): Promise<string> {
  const lines: string[] = [
    `version: ${binaries.version} (repo: plugin-managed binaries)`,
    `openai adapter binary: ${binaries.openai}`,
    `proxy MCP binary: ${binaries.proxy}`,
  ]
  const ready = await probeReadiness(opts.adapterHost, opts.adapterPort)
  lines.push(ready.ok ? `ready: ${ready.detail}` : `NOT READY: ${ready.detail}`)
  const cdp = await probeChromeCDP(opts.cdpPort)
  lines.push(cdp.ok ? `chrome CDP (:${opts.cdpPort}): answering` : `chrome CDP (:${opts.cdpPort}): ${cdp.detail}`)
  return lines.join("\n")
}

export async function doctorReport(
  opts: ResolvedOptions,
  binaries: { openai: string; proxy: string; version: string },
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = []
  // Platform-aware redownload hint (LOCALAPPDATA on win32, ~/.local/share elsewhere).
  const redownloadHint =
    `Delete the versioned cache dir (${cacheDir(binaries.version)}) and restart opencode to re-download.`
  for (const [name, p] of [["chatgpt-openai", binaries.openai], ["chatgpt-proxy", binaries.proxy]] as const) {
    try {
      await fs.promises.access(p, fs.constants.X_OK)
      lines.push({ name: `binary present+executable: ${name}`, ok: true, detail: p })
    } catch {
      lines.push({
        name: `binary present+executable: ${name}`,
        ok: false,
        detail: `missing or not executable: ${p}`,
        hint: redownloadHint,
      })
    }
  }
  const portOpen = await tcpProbe(opts.adapterHost, opts.adapterPort, 1500)
  lines.push({
    name: `adapter port open (${opts.adapterHost}:${opts.adapterPort})`,
    ok: portOpen,
    detail: portOpen ? "listening" : "not listening",
    hint: portOpen ? undefined : "Restart opencode — the plugin supervisor spawns the adapter. Check ~/.local/share/opencode-web-bridges/logs/chatgpt-openai.log.",
  })
  const cdp = await probeChromeCDP(opts.cdpPort)
  lines.push({
    name: `chrome answering (CDP :${opts.cdpPort})`,
    ok: cdp.ok,
    detail: cdp.detail,
    hint: cdp.ok ? undefined : "Run /chatgpt-login to launch the profile Chrome.",
  })
  let adapterVersion = "unknown"
  try {
    const { status, body } = await httpGet(opts.adapterHost, opts.adapterPort, "/healthz", 3000)
    adapterVersion = status === 200 ? (body || "ok") : `HTTP ${status}`
  } catch (error) {
    adapterVersion = `unreachable: ${describeError(error)}`
  }
  const ready = portOpen ? await probeReadiness(opts.adapterHost, opts.adapterPort) : null
  const loggedIn = ready?.ok === true
  lines.push({
    name: "adapter version (/healthz)",
    ok: portOpen,
    detail: adapterVersion,
  })
  lines.push({
    name: "login state (/readyz)",
    ok: loggedIn,
    detail: ready ? ready.detail : "adapter down — cannot determine login state",
    hint: loggedIn
      ? undefined
      : "Log into ChatGPT once in the profile Chrome window (/chatgpt-login opens it), then re-run /chatgpt-status.",
  })
  return lines
}

export function formatDoctor(lines: DoctorLine[]): string {
  return lines
    .map((l) => `${l.ok ? "PASS" : "FAIL"}  ${l.name}: ${l.detail}${l.hint ? `\n      repair: ${l.hint}` : ""}`)
    .join("\n")
}

/** Launch the profile Chrome window so the user can log in, then re-probe. */
export async function loginFlow(opts: ResolvedOptions): Promise<string> {
  const chrome = findChromeBinary()
  if (!chrome) {
    return [
      "Could not find a Chrome binary.",
      "Install Google Chrome, or set CHROME_BIN to its path, then retry /chatgpt-login.",
    ].join("\n")
  }
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${opts.cdpPort}`,
      `--user-data-dir=${opts.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://chatgpt.com",
    ],
    { detached: true, stdio: "ignore" },
  )
  child.unref()
  // Give Chrome a moment, then re-probe CDP + readiness.
  await new Promise((r) => setTimeout(r, 2500))
  const cdp = await probeChromeCDP(opts.cdpPort)
  const ready = await probeReadiness(opts.adapterHost, opts.adapterPort)
  return [
    `profile Chrome launched (pid ${child.pid ?? "unknown"}). Log into ChatGPT there once —`,
    `the session persists in ${opts.profileDir}.`,
    `CDP (:${opts.cdpPort}): ${cdp.detail}`,
    ready.ok ? `bridge: ${ready.detail}` : `bridge: ${ready.detail} — re-run /chatgpt-status after logging in.`,
  ].join("\n")
}
