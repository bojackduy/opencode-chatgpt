import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { assetName, currentPlatform, downloadURL, ensureBinaries } from "../server/binaries"
import { resolveOptions } from "../server/options"
import { chromeCandidates } from "../server/supervisor"
import { globalConfigDir, hostFromVersion, planConfig, type Host } from "./config"
import { buildSource, validateRef } from "./source-build"
import { sourceBinaries, validateRepo } from "../server/source"
import { tcpProbe } from "../server/supervisor"

export const HELP = `opencode-chatgpt installer

Usage: npx @bojackduy/opencode-chatgpt install [--config PATH] [--host v1|v2|auto] [--dry-run]
       npx @bojackduy/opencode-chatgpt install --build-from-source --bridge-ref <tag-or-commit>
       opencode-chatgpt --help

Registers only the npm plugin; prepares both checksum-verified Go bridge binaries.
Default: global OpenCode config (OPENCODE_CONFIG_DIR, otherwise XDG_CONFIG_HOME/opencode).
Auto detects opencode --version. Dry-run requires --host v1 or v2 and never spawns,
downloads, or writes. Existing options and disabled entries are preserved.
Prerequisites: Node >=20, OpenCode, Bun >=1.1, Chrome/Chromium (or CHROME_BIN).
Source mode additionally requires Go compatible with downloaded go.mod (GOTOOLCHAIN=auto
may download a toolchain), network access, and a ref pushed to GitHub. No release fallback.
Restart OpenCode after installation; one-time ChatGPT profile login is required.
`

export interface InstallArgs { config?: string; host: Host | "auto"; dryRun: boolean; buildFromSource?: boolean; bridgeRef?: string }
export function parseArgs(args: string[]): InstallArgs | "help" {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return "help"
  if (args[0] !== "install") throw new Error("Expected install; use --help for usage")
  const result: InstallArgs = { host: "auto", dryRun: false }
  const seen = new Set<string>()
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--help" || arg === "-h") return "help"
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`)
    seen.add(arg)
    if (arg === "--dry-run") { result.dryRun = true; continue }
    if (arg === "--build-from-source") { result.buildFromSource = true; continue }
    if (arg !== "--host" && arg !== "--config" && arg !== "--bridge-ref") throw new Error(`Unknown option: ${arg}`)
    const value = args[++i]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
    if (arg === "--bridge-ref") { validateRef(value); result.bridgeRef = value }
    else if (arg === "--config") result.config = path.resolve(value)
    else if (["auto", "v1", "v2"].includes(value)) result.host = value as InstallArgs["host"]
    else throw new Error("--host must be v1, v2 or auto")
  }
  if (!!result.buildFromSource !== !!result.bridgeRef) throw new Error("--build-from-source requires --bridge-ref <tag-or-commit> (and vice versa)")
  return result
}

/** argv only, bounded timeout; no shell or detached processes. */
export function commandVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Cannot run ${command} --version`)
  return result.stdout.trim()
}

export async function checkPrerequisites(): Promise<void> {
  let bun: string
  try { bun = commandVersion("bun") } catch { throw new Error("Bun >=1.1 is required by the plugin. Install it from https://bun.sh/docs/installation, then retry.") }
  const version = /^(\d+)\.(\d+)\.\d+/.exec(bun)
  if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 1)) {
    throw new Error("Bun >=1.1 is required. Upgrade from https://bun.sh/docs/installation.")
  }
  const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : chromeCandidates(process.platform, process.env)
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
      if ((await fs.stat(candidate)).isFile()) return
    } catch { /* inspect next candidate without launching a browser */ }
  }
  throw new Error("Chrome/Chromium not found. Install Google Chrome from https://www.google.com/chrome/ or set CHROME_BIN to an existing executable. No browser was launched or installed.")
}

async function readConfig(file: string): Promise<{ source: string; mode: number } | undefined> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Config must be a regular file (not a symlink): ${file}`)
    return { source: await fs.readFile(file, "utf8"), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function configTarget(explicit: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  if (explicit) return explicit
  const dir = globalConfigDir(env)
  const candidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"].map(n => path.join(dir, n))
  const existing: string[] = []
  for (const file of candidates) if (await readConfig(file)) existing.push(file)
  if (existing.length > 1) throw new Error(`Multiple global config files found; pass --config to select the exact file: ${existing.join(", ")}`)
  return existing[0] ?? path.join(dir, "opencode.jsonc")
}

export interface InstallDependencies {
  env: NodeJS.ProcessEnv
  version: typeof commandVersion
  prerequisites: () => Promise<void>
  prepare: typeof ensureBinaries
  buildSource: typeof buildSource
  sourceBinaries: typeof sourceBinaries
  probe: typeof tcpProbe
  log: (message: string) => void
}

export async function install(args: InstallArgs, injected: Partial<InstallDependencies> = {}): Promise<void> {
  const deps: InstallDependencies = { env: process.env, version: commandVersion, prerequisites: checkPrerequisites, prepare: ensureBinaries, buildSource, sourceBinaries, probe: tcpProbe, log: console.log, ...injected }
  if (!!args.buildFromSource !== !!args.bridgeRef) throw new Error("--build-from-source requires --bridge-ref <tag-or-commit> (and vice versa)")
  if (args.bridgeRef) validateRef(args.bridgeRef)
  if (args.dryRun && args.host === "auto") throw new Error("Dry-run never spawns opencode; pass --host v1 or --host v2.")
  let host: Host
  try { host = args.host === "auto" ? hostFromVersion(deps.version("opencode")) : args.host }
  catch { throw new Error("Cannot identify installed OpenCode version; pass --host v1 or --host v2.") }
  const target = await configTarget(args.config, deps.env)
  const original = await readConfig(target)
  const source = original?.source ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
  let plan = planConfig(source, host)
  deps.log(`Config (${host}): ${target}`)
  if (plan.disabled) {
    deps.log("Existing ChatGPT plugin entry is explicitly disabled; preserved without downloading or enabling. Check your host's disabled-entry schema before enabling manually.")
    return
  }
  const opts = resolveOptions(plan.options)
  // Repo/tag form is restricted before constructing URLs or cache paths.
  validateRepo(opts.releasesRepo)
  if (!/^[\w.-]+$/.test(opts.version) || [".", ".."].includes(opts.version)) {
    throw new Error("Invalid releasesRepo or bridge version in existing plugin options")
  }
  const platform = currentPlatform()
  if (args.buildFromSource) deps.log(`Source build: ${opts.releasesRepo}@${args.bridgeRef}; resolve full SHA, build ./cmd/chatgpt-openai and ./cmd/proxy for ${platform}; persist bridgeSource after success.`)
  else if (opts.bridgeSource) deps.log(`Pinned source cache: ${opts.bridgeSource.repo}@${opts.bridgeSource.commit}`)
  else {
    for (const name of ["chatgpt-openai", "chatgpt-proxy"] as const) deps.log(`Required asset: ${downloadURL(opts.releasesRepo, opts.version, assetName(name, platform))}`)
    deps.log(`Checksums: ${downloadURL(opts.releasesRepo, opts.version, "checksums.txt")}`)
  }
  if (args.dryRun) {
    deps.log("Dry-run: no downloads, processes, or writes; Bun >=1.1 and Chrome/Chromium must be installed.")
    deps.log(plan.changed ? `Exact resulting config:\n${plan.source}` : `No config changes; existing registration/options retained:\n${plan.source}`)
    return
  }
  await deps.prerequisites()
  if (args.buildFromSource) {
    const bridgeSource = await deps.buildSource(opts.releasesRepo, args.bridgeRef!, platform)
    plan = planConfig(source, host, { bridgeSource })
    deps.log(`Selected source commit: ${bridgeSource.commit}`)
  } else if (opts.bridgeSource) await deps.sourceBinaries(opts.bridgeSource, platform)
  else await deps.prepare({ releasesRepo: opts.releasesRepo, version: opts.version, platform })
  if ((args.buildFromSource || opts.bridgeSource) && await deps.probe(opts.adapterHost, opts.adapterPort, 1000)) {
    deps.log(`WARNING: Adapter port ${opts.adapterHost}:${opts.adapterPort} is already occupied. It may be an independent service or older build; installation does not replace or stop it. Have its owner stop/reconfigure it (including any launchd unit), restart OpenCode, then verify the managed process executable matches the selected cache path with /chatgpt-doctor. Readiness alone does not prove build identity.`)
  }
  if (plan.changed) {
    // Re-read after downloads: never overwrite concurrent user edits.
    const current = await readConfig(target)
    if (current?.source !== original?.source) throw new Error("Config changed during binary preparation; retry. No config edits made.")
    await fs.mkdir(path.dirname(target), { recursive: true })
    const token = randomUUID()
    const temporary = `${target}.${token}.tmp`
    const backup = `${target}.${token}.bak`
    try {
      if (original) {
        await fs.writeFile(backup, original.source, { flag: "wx", mode: original.mode })
        deps.log(`Backup: ${backup}`)
      }
      await fs.writeFile(temporary, plan.source, { flag: "wx", mode: original?.mode ?? 0o600 })
      await fs.rename(temporary, target)
    } finally { await fs.rm(temporary, { force: true }) }
    deps.log("Registered ChatGPT plugin.")
  } else deps.log("Already registered; existing pin/options retained, no config write or backup needed.")
  deps.log("Restart OpenCode, then select chatgpt-web/chatgpt-web in /models. The plugin registers the model at runtime; your default model is unchanged.")
  deps.log(host === "v2" ? "Run /chatgpt-login for one-time profile login, then /chatgpt-doctor." : "Ask the agent to call chatgpt-login for one-time profile login, then chatgpt-doctor (v1 tools).")
  deps.log("Installer did not launch Chrome, adapters, launchd units or services; the plugin owns supervision after restart.")
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseArgs(argv)
    if (args === "help") console.log(HELP)
    else await install(args)
  } catch (error) {
    console.error(`opencode-chatgpt: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
