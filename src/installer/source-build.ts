import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { assetName, currentPlatform, type PlatformId } from "../server/binaries"
import { sourceBinaries, sourceCacheDir, validateRepo, type BridgeSource } from "../server/source"

export function validateRef(ref: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(ref) || ref.includes("..") || ref.endsWith("/")) throw new Error("Invalid --bridge-ref; use a GitHub tag or commit")
}
export interface SourceDependencies {
  fetch: typeof fetch
  run: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => string | Promise<string>
  root?: string
  signal?: AbortSignal
}
async function runGo(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  try {
    const r = await promisify(execFile)("go", args, { cwd, env, signal, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    return r.stdout.trim()
  } catch (error) { throw new Error(`Go ${args[0]} failed: ${String(error)}. Install Go compatible with go.mod; GOTOOLCHAIN=auto may download the required toolchain.`) }
}

/** Restricted tar reader: only directories/files, no links, special files or path overrides. */
export async function extractSource(archive: Uint8Array, destination: string): Promise<string> {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 })
  let root: string | undefined
  const text = (b: Buffer) => b.toString("utf8").split("\0")[0]!
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512)
    if (h.every(b => b === 0)) break
    const sizeText = text(h.subarray(124, 136)).trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid source archive size")
    const size = parseInt(sizeText, 8)
    const expected = parseInt(text(h.subarray(148, 156)).trim(), 8)
    const actual = h.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0)
    if (expected !== actual || offset + 512 + size > tar.length) throw new Error("Invalid source archive header")
    const type = text(h.subarray(156, 157))
    const prefix = text(h.subarray(345, 500))
    const name = (prefix ? `${prefix}/` : "") + text(h.subarray(0, 100))
    const parts = name.replace(/\/$/, "").split("/")
    if (!name || name.includes("\\") || name.includes(":") || parts.some(p => !p || p === "." || p === "..")) throw new Error("Unsafe source archive path")
    // GitHub emits a global pax comment with the commit ID; never apply path overrides.
    if (type !== "g") {
      if (!["", "0", "5"].includes(type)) throw new Error("Unsupported source archive entry (links/path overrides are forbidden)")
      root ??= parts[0]
      if (parts[0] !== root) throw new Error("Source archive must have one root")
      const dest = path.join(destination, ...parts)
      if (type === "5") await fs.mkdir(dest, { recursive: true })
      else {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, tar.subarray(offset + 512, offset + 512 + size), { flag: "wx", mode: 0o600 })
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!root) throw new Error("Empty source archive")
  return path.join(destination, root)
}

export async function buildSource(repo: string, ref: string, platform: PlatformId = currentPlatform(), injected: Partial<SourceDependencies> = {}): Promise<BridgeSource> {
  validateRepo(repo); validateRef(ref)
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error("Source build cancelled"))
  const signal = injected.signal ?? controller.signal
  const deps: SourceDependencies = { fetch, run: (args, cwd, env) => runGo(args, cwd, env, signal), ...injected, signal }
  const request = async (url: string) => {
    const response = await deps.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), headers: { Accept: "application/vnd.github+json" } })
    if (!response.ok || (response.url && !response.url.startsWith("https://"))) throw new Error(`GitHub source request failed: HTTP ${response.status}`)
    return response
  }
  const resolved = await (await request(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)).json() as { sha?: unknown }
  if (typeof resolved.sha !== "string" || !/^[a-f0-9]{40}$/.test(resolved.sha)) throw new Error("GitHub did not return an immutable full commit SHA")
  const source = { repo, commit: resolved.sha }
  try { await sourceBinaries(source, platform, deps.root); return source } catch { /* rebuild invalid/missing cache */ }
  const dir = sourceCacheDir(source, platform, deps.root)
  await fs.mkdir(path.dirname(dir), { recursive: true })
  const staging = await fs.mkdtemp(`${dir}.build-`)
  let temporary: string | undefined
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-chatgpt-source-"))
    deps.signal?.throwIfAborted()
    const archive = await request(`https://codeload.github.com/${repo}/tar.gz/${source.commit}`)
    if (!archive.body) throw new Error("Empty source response")
    const chunks: Uint8Array[] = []
    let bytesRead = 0
    for await (const chunk of archive.body as unknown as AsyncIterable<Uint8Array>) {
      bytesRead += chunk.length
      if (bytesRead > 32 * 1024 * 1024) throw new Error("Source archive exceeds 32 MiB limit")
      chunks.push(chunk)
    }
    const work = await extractSource(Buffer.concat(chunks), temporary)
    const mod = await fs.readFile(path.join(work, "go.mod"), "utf8")
    const required = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(mod)?.[1]
    if (!required) throw new Error("Downloaded go.mod has no valid Go version")
    const env = { ...process.env, GOOS: platform.split("-")[0], GOARCH: platform.split("-")[1] }
    // Run in the module so Go's standard GOTOOLCHAIN policy (including auto) applies.
    const version = await deps.run(["env", "GOVERSION"], work, env)
    const found = /^go(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version)
    const want = required.split(".").map(Number)
    if (!found || [Number(found[1]), Number(found[2]), Number(found[3] ?? 0)].some((v, i, a) => a.slice(0, i).every((n, j) => n === (want[j] ?? 0)) && v < (want[i] ?? 0))) throw new Error(`Go ${required} or newer required by go.mod (selected ${version}); enable GOTOOLCHAIN=auto or install a compatible Go.`)
    const hashes: Record<string, string> = {}
    for (const [name, target] of [["chatgpt-openai", "./cmd/chatgpt-openai"], ["chatgpt-proxy", "./cmd/proxy"]] as const) {
      deps.signal?.throwIfAborted()
      const filename = assetName(name, platform)
      const output = path.join(staging, filename)
      await deps.run(["build", "-o", output, target], work, env)
      if (!platform.startsWith("windows-")) await fs.chmod(output, 0o755)
      const bytes = await fs.readFile(output)
      if (!bytes.length) throw new Error("Go produced an empty executable")
      hashes[filename] = createHash("sha256").update(bytes).digest("hex")
    }
    deps.signal?.throwIfAborted()
    await fs.writeFile(path.join(staging, "build.json"), JSON.stringify({ schema: 1, ...source, platform, hashes }))
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rename(staging, dir)
    await sourceBinaries(source, platform, deps.root)
    return source
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
    await fs.rm(staging, { recursive: true, force: true })
    if (temporary) await fs.rm(temporary, { recursive: true, force: true })
  }
}
