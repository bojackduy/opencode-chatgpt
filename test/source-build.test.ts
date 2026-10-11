import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { gzipSync } from "node:zlib"
import { buildSource, extractSource, type SourceDependencies } from "../src/installer/source-build"
import { sourceBinaries, sourceCacheDir, validateSource } from "../src/server/source"
import { resolveOptions } from "../src/server/options"
import { install, parseArgs } from "../src/installer/install"
import { PACKAGE, planConfig } from "../src/installer/config"

const dirs: string[] = []
const sha = "a".repeat(40)
const source = { repo: "owner/bridge", commit: sha }
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "source test spaces-")); dirs.push(dir); return dir }
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }) })
function archive(entries: [string, string, string?][] = [["bridge/go.mod", "module example.com/bridge\n\ngo 1.24.0\n"]]) {
  const blocks: Buffer[] = []
  for (const [name, content, type = "0"] of entries) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name); h.write("0000600\0", 100); h.write(data.length.toString(8).padStart(11, "0") + "\0", 124)
    h.fill(32, 148, 156); h.write(type, 156); h.write("ustar\0", 257)
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
async function fixture(platform: "darwin-arm64" | "windows-amd64" = "darwin-arm64") {
  const root = await temp()
  const calls: string[][] = [], urls: string[] = [], workdirs: string[] = []
  const deps: Partial<SourceDependencies> = {
    root,
    fetch: (async (url: string) => {
      urls.push(url)
      return url.includes("api.github.com") ? Response.json({ sha }) : new Response(archive())
    }) as typeof fetch,
    run: async (args, cwd, env) => {
      calls.push(args); workdirs.push(cwd)
      expect(env.GOOS).toBe(platform.split("-")[0]); expect(env.GOARCH).toBe(platform.split("-")[1])
      if (args[0] === "env") return "go1.25.1"
      await fs.writeFile(args[2]!, "fake executable")
      return ""
    },
  }
  return { root, calls, urls, workdirs, deps, platform }
}
test("resolves SHA, pins HTTPS archive, builds exact argv in paths with spaces; verifies cache and Windows extensions", async () => {
  for (const platform of ["darwin-arm64", "windows-amd64"] as const) {
    const f = await fixture(platform)
    expect(await buildSource(source.repo, "v1.2.3", platform, f.deps)).toEqual(source)
    expect(f.urls[1]).toBe(`https://codeload.github.com/owner/bridge/tar.gz/${sha}`)
    expect(f.calls.map(a => a.at(-1))).toEqual(["GOVERSION", "./cmd/chatgpt-openai", "./cmd/proxy"])
    expect(f.calls[1]![2]).toContain("source test spaces-")
    const binaries = await sourceBinaries(source, platform, f.root)
    expect(binaries.openai.endsWith(".exe")).toBe(platform === "windows-amd64")
    for (const cwd of f.workdirs) expect(await fs.exists(cwd)).toBe(false)
    await buildSource(source.repo, sha, platform, f.deps)
    expect(f.calls).toHaveLength(3)
    expect(f.urls).toHaveLength(3) // cache hit still resolves requested ref
    await fs.writeFile(binaries.proxy, "tampered")
    await expect(sourceBinaries(source, platform, f.root)).rejects.toThrow("rerun install")
    await fs.rm(path.join(sourceCacheDir(source, platform, f.root), "build.json"))
    await expect(sourceBinaries(source, platform, f.root)).rejects.toThrow("Startup never builds")
  }
})
test("invalid repository/ref/SHA and GitHub failures never spawn Go", async () => {
  const f = await fixture()
  for (const [repo, ref] of [["../bad", "v1"], [source.repo, "../bad"], [source.repo, "-flag"]]) await expect(buildSource(repo!, ref!, f.platform, f.deps)).rejects.toThrow()
  for (const response of [Response.json({ sha: "short" }), new Response("missing", { status: 404 })]) {
    f.deps.fetch = (async () => response) as unknown as typeof fetch
    await expect(buildSource(source.repo, "v1", f.platform, f.deps)).rejects.toThrow()
  }
  expect(f.calls).toHaveLength(0)
  expect(await fs.readdir(f.root)).toEqual([])
})
test("build failure, incompatible Go and cancellation clean staging and source, no artifact record", async () => {
  for (const mode of ["failure", "old-go", "cancel"] as const) {
    const f = await fixture()
    const controller = new AbortController()
    f.deps.signal = controller.signal
    f.deps.run = async (args, cwd) => {
      f.workdirs.push(cwd)
      if (args[0] === "env") return mode === "old-go" ? "go1.23.9" : "go1.24.0"
      if (args.at(-1) === "./cmd/proxy") throw new Error("second build failed")
      await fs.writeFile(args[2]!, "first binary")
      if (mode === "cancel") controller.abort()
      return ""
    }
    await expect(buildSource(source.repo, sha, f.platform, f.deps)).rejects.toThrow()
    const dir = sourceCacheDir(source, f.platform, f.root)
    expect(await fs.exists(dir)).toBe(false)
    expect(await fs.readdir(path.dirname(dir))).toEqual([])
    for (const cwd of f.workdirs) expect(await fs.exists(cwd)).toBe(false)
  }
})
test("restricted extraction rejects traversal, absolute/Windows paths, symlinks, hardlinks and pax overrides", async () => {
  const dir = await temp()
  for (const [name, type] of [["../escape", "0"], ["/escape", "0"], ["C:/escape", "0"], ["bridge/../escape", "0"], ["bridge\\escape", "0"], ["bridge/link", "2"], ["bridge/link", "1"], ["bridge/pax", "x"]]) {
    await expect(extractSource(archive([[name!, "", type]]), dir)).rejects.toThrow()
  }
  expect(await fs.readdir(dir)).toEqual([])
})
test("v1/v2 source selection preserves options/package pin, remains idempotent and validates runtime descriptor", () => {
  for (const host of ["v1", "v2"] as const) {
    const entry = host === "v1" ? [PACKAGE + "@0.1.0", { cdpPort: 9333 }] : { package: PACKAGE + "@0.1.0", options: { cdpPort: 9333 } }
    const text = `// keep\n${JSON.stringify({ [host === "v1" ? "plugin" : "plugins"]: ["other", entry] })}`
    const plan = planConfig(text, host, { bridgeSource: source })
    expect(plan.source).toContain("// keep"); expect(plan.source).toContain(PACKAGE + "@0.1.0")
    expect(resolveOptions(plan.options).bridgeSource).toEqual(source)
    expect(plan.options.cdpPort).toBe(9333)
    expect(planConfig(plan.source, host, { bridgeSource: source }).changed).toBe(false)
    expect(planConfig("{}", host, { bridgeSource: source }).options.bridgeSource).toEqual(source)
  }
  expect(() => validateSource({ ...source, commit: "short" })).toThrow()
  expect(() => resolveOptions({ bridgeSource: "bad" })).toThrow()
})
test("source installer is transactional; dry-run no GitHub/Go/probe/write; failure no config mutation", async () => {
  const dir = await temp(), config = path.join(dir, "config.jsonc")
  const original = `// retain\n{"plugin":[["${PACKAGE}",{"profileDir":"/profile spaces","cdpPort":9333}]]}`
  await fs.writeFile(config, original)
  const logs: string[] = [], calls: string[] = []
  const args = { config, host: "v1" as const, dryRun: true, buildFromSource: true, bridgeRef: "v1" }
  const deps = {
    log: (m: string) => logs.push(m), prerequisites: async () => { calls.push("prereq") },
    buildSource: async () => { calls.push("build"); return source },
    probe: async () => { calls.push("probe"); return true },
  }
  await install(args, deps)
  expect(calls).toEqual([]); expect(logs.join("\n")).toContain("@v1")
  expect(await fs.readFile(config, "utf8")).toBe(original)
  await expect(install({ ...args, dryRun: false }, { ...deps, buildSource: async () => { throw new Error("build failed") } })).rejects.toThrow("build failed")
  expect(await fs.readdir(dir)).toEqual(["config.jsonc"])
  await install({ ...args, dryRun: false }, deps)
  expect(logs.join("\n")).toContain("independent service")
  const updated = await fs.readFile(config, "utf8")
  expect(planConfig(updated, "v1").options).toEqual({ profileDir: "/profile spaces", cdpPort: 9333, bridgeSource: source })
  const files = await fs.readdir(dir)
  await install({ ...args, dryRun: false }, deps)
  expect(await fs.readdir(dir)).toEqual(files)
  for (const argv of [["install", "--build-from-source"], ["install", "--bridge-ref", "v1"]]) expect(() => parseArgs(argv)).toThrow("requires")
})
