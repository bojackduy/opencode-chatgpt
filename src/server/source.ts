import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { assetName, cacheDir, currentPlatform, type EnsuredBinaries, type PlatformId } from "./binaries"

export interface BridgeSource { repo: string; commit: string }
export function validateRepo(repo: string): void {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || [".", ".."].includes(repo.split("/")[1]!)) throw new Error("Invalid GitHub bridge repository")
}
export function validateSource(value: unknown): BridgeSource {
  const s = value as BridgeSource | undefined
  if (!s || typeof s.repo !== "string" || typeof s.commit !== "string" || !/^[a-f0-9]{40}$/.test(s.commit)) throw new Error("bridgeSource requires repo and full lowercase commit SHA")
  validateRepo(s.repo)
  return { repo: s.repo, commit: s.commit }
}
export function sourceCacheDir(source: BridgeSource, platform: PlatformId, root?: string): string {
  validateSource(source)
  const repoKey = createHash("sha256").update(source.repo.toLowerCase()).digest("hex")
  return path.join(root ?? cacheDir("source", platform.startsWith("windows-") ? "win32" : process.platform), repoKey, source.commit, platform)
}
export async function sourceBinaries(source: BridgeSource, platform = currentPlatform(), root?: string): Promise<EnsuredBinaries> {
  const dir = sourceCacheDir(source, platform, root)
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(dir, "build.json"), "utf8"))
    if (metadata.schema !== 1 || metadata.repo !== source.repo || metadata.commit !== source.commit || metadata.platform !== platform) throw new Error("metadata mismatch")
    const files = ["chatgpt-openai", "chatgpt-proxy"].map(n => path.join(dir, assetName(n as "chatgpt-openai" | "chatgpt-proxy", platform)))
    for (const file of files) {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("invalid binary")
      await fs.access(file, platform.startsWith("windows-") ? fs.constants.F_OK : fs.constants.X_OK)
      const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex")
      if (metadata.hashes?.[path.basename(file)] !== hash) throw new Error("binary hash mismatch")
    }
    return { openai: files[0]!, proxy: files[1]!, version: `source:${source.commit}` }
  } catch {
    throw new Error(`Source build missing or invalid (${source.repo}@${source.commit}); rerun install --build-from-source --bridge-ref ${source.commit}. Startup never builds or falls back to releases.`)
  }
}
