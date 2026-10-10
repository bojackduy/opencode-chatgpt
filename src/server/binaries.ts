// Managed binary resolution: platform/arch → release asset mapping,
// versioned cache dir, download + sha256 verification.
// Pure mapping/version logic is unit-tested; download is I/O.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

export type ManagedBinary = "chatgpt-openai" | "chatgpt-proxy"
// Platform IDs use Go naming (goos-goarch): amd64, never x64.
// Windows assets carry a `.exe` suffix (see assetName); everything else has
// no extension, matching the chatgpt-proxy release workflow.
export type PlatformId =
  | "darwin-arm64"
  | "darwin-amd64"
  | "linux-amd64"
  | "linux-arm64"
  | "windows-amd64"
  | "windows-arm64"

export const SUPPORTED_PLATFORMS: readonly PlatformId[] = [
  "darwin-arm64",
  "darwin-amd64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64",
] as const

/** True for the Windows release platforms (assets end in `.exe`). */
export function isWindowsPlatformId(platform: PlatformId): boolean {
  return platform.startsWith("windows-")
}

/**
 * Map a Node platform/arch pair to a supported release platform.
 * Refuses anything else with a clear error.
 */
export function currentPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformId {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64"
  if (platform === "darwin" && arch === "x64") return "darwin-amd64"
  if (platform === "linux" && arch === "x64") return "linux-amd64"
  if (platform === "linux" && arch === "arm64") return "linux-arm64"
  if (platform === "win32" && arch === "x64") return "windows-amd64"
  if (platform === "win32" && arch === "arm64") return "windows-arm64"
  throw new Error(
    `opencode-chatgpt: unsupported platform ${platform}/${arch} — ` +
      `prebuilt binaries exist for ${SUPPORTED_PLATFORMS.join(", ")} only`,
  )
}

/**
 * Asset naming convention produced by the chatgpt-proxy release workflow:
 *   <binary>-<goos>-<goarch>[.exe]   (windows assets gain `.exe`)
 * e.g. chatgpt-openai-darwin-arm64, chatgpt-proxy-linux-amd64,
 *      chatgpt-proxy-windows-amd64.exe
 */
export function assetName(binary: ManagedBinary, platform: PlatformId): string {
  const base = `${binary}-${platform}`
  return isWindowsPlatformId(platform) ? `${base}.exe` : base
}

export function checksumName(): string {
  return "checksums.txt"
}

export function releaseBaseURL(releasesRepo: string, version: string): string {
  const tag = version === "latest" ? "latest/download" : `download/${version}`
  return `https://github.com/${releasesRepo}/releases/${tag}`
}

export function downloadURL(
  releasesRepo: string,
  version: string,
  asset: string,
): string {
  return `${releaseBaseURL(releasesRepo, version)}/${asset}`
}

/**
 * Versioned cache dir.
 *
 * - posix (darwin/linux): `~/.local/share/opencode-chatgpt/<version>/`
 *   (XDG_DATA_HOME default; `os.homedir()` resolves `~` on every platform).
 * - win32: `%LOCALAPPDATA%/opencode-chatgpt/<version>/`
 *   (falls back to `~/AppData/Local` when LOCALAPPDATA is unset).
 *
 * `platform`/`env` are injectable so unit tests can cover the win32 branch
 * without a Windows box. Node API note: `path.join` emits `\` separators on
 * win32 automatically — no manual separator handling needed.
 */
export function cacheDir(
  version: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const safe = version.replace(/[^A-Za-z0-9._-]+/g, "_")
  if (platform === "win32") {
    const base =
      (env["LOCALAPPDATA"]?.trim() ? env["LOCALAPPDATA"]! : undefined) ??
      path.join(os.homedir(), "AppData", "Local")
    return path.join(base, "opencode-chatgpt", safe)
  }
  return path.join(os.homedir(), ".local", "share", "opencode-chatgpt", safe)
}

/**
 * Compare version strings. Handles "v" prefixes and "latest" (latest sorts
 * above any numbered version). Returns <0 / 0 / >0.
 */
export function compareVersions(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === null && nb === null) return a < b ? -1 : a > b ? 1 : 0
  if (na === null) return 1 // "latest" (or unparseable) sorts above numbered
  if (nb === null) return -1
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const diff = (na[i] ?? 0) - (nb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function normalize(v: string): number[] | null {
  const t = v.trim()
  if (t === "" || t.toLowerCase() === "latest") return null
  const m = /^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(t)
  if (!m) return null
  return m[1]!.split(".").map(Number)
}

export interface EnsuredBinaries {
  openai: string
  proxy: string
  version: string
}

/**
 * Ensure both managed binaries exist in the versioned cache dir, downloading
 * and sha256-verifying them against the release checksums.txt when missing.
 */
export async function ensureBinaries(opts: {
  releasesRepo: string
  version: string
  platform?: PlatformId
}): Promise<EnsuredBinaries> {
  const platform = opts.platform ?? currentPlatform()
  const dir = cacheDir(opts.version, platformToNode(platform))
  await fs.promises.mkdir(dir, { recursive: true })
  const openai = await ensureOne(dir, "chatgpt-openai", platform, opts)
  const proxy = await ensureOne(dir, "chatgpt-proxy", platform, opts)
  return { openai, proxy, version: opts.version }
}

/**
 * Map a PlatformId back to the Node `process.platform` value it came from,
 * so cacheDir picks the per-OS base dir. Defaults to the live platform for
 * forward-compat if a new PlatformId ever lacks a mapping.
 */
function platformToNode(platform: PlatformId): string {
  if (platform.startsWith("windows-")) return "win32"
  if (platform.startsWith("darwin-")) return "darwin"
  if (platform.startsWith("linux-")) return "linux"
  return process.platform
}

async function ensureOne(
  dir: string,
  binary: ManagedBinary,
  platform: PlatformId,
  opts: { releasesRepo: string; version: string },
): Promise<string> {
  const dest = path.join(dir, assetName(binary, platform))
  if (await isExecutable(dest, platform)) return dest
  const base = releaseBaseURL(opts.releasesRepo, opts.version)
  const tmpAsset = `${dest}.download`
  await downloadTo(`${base}/${path.basename(dest)}`, tmpAsset)
  const checksums = await downloadText(`${base}/${checksumName()}`)
  verifyChecksum(checksums, path.basename(dest), tmpAsset)
  await fs.promises.rename(tmpAsset, dest)
  // No chmod on Windows: executability comes from the `.exe` extension + NTFS
  // ACLs, and chmod is a no-op there. POSIX keeps the explicit 0755 so a
  // umask-stripped download stays runnable.
  if (!isWindowsPlatformId(platform)) {
    await fs.promises.chmod(dest, 0o755)
  }
  return dest
}

async function isExecutable(p: string, platform?: PlatformId): Promise<boolean> {
  try {
    // Node API note: X_OK on win32 only checks existence (no POSIX exec bit),
    // so check F_OK there — existence + isFile() is the meaningful gate since
    // the `.exe` extension is what makes it runnable.
    const mode = platform !== undefined && isWindowsPlatformId(platform) ? fs.constants.F_OK : fs.constants.X_OK
    await fs.promises.access(p, mode)
    const st = await fs.promises.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok || !res.body) throw new Error(`download failed ${url}: HTTP ${res.status}`)
  const file = fs.createWriteStream(dest, { mode: 0o755 })
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await new Promise<void>((resolve, reject) =>
        file.write(value, (err) => (err ? reject(err) : resolve())),
      )
    }
  } finally {
    await new Promise<void>((resolve) => file.close(() => resolve()))
  }
}

async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`checksum download failed ${url}: HTTP ${res.status}`)
  return await res.text()
}

/** Verify a downloaded file against BSD/GNU-style `sha256  filename` lines. */
export function verifyChecksum(checksumsText: string, asset: string, filePath: string): void {
  const entry = checksumsText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => {
      const parts = l.split(/\s+/)
      return parts.length >= 2 && parts[parts.length - 1]!.replace(/^\*/, "") === asset
    })
  if (!entry) throw new Error(`no checksum entry for ${asset} in ${checksumName()}`)
  const expected = entry.split(/\s+/)[0]!.toLowerCase()
  const actual = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
  }
}
