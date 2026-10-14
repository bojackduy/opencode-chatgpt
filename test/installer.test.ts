import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { spawnSync } from "node:child_process"
import { install, parseArgs, type InstallDependencies } from "../src/installer/install"
import { PACKAGE } from "../src/installer/config"

const directories: string[] = []
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-install-test-"))
  directories.push(dir)
  const config = path.join(dir, "opencode.jsonc")
  const messages: string[] = []
  const calls: string[] = []
  const deps: Partial<InstallDependencies> = {
    env: { OPENCODE_CONFIG_DIR: dir },
    version: command => { calls.push(command); return "2.0.11" },
    prerequisites: async () => { calls.push("prerequisites") },
    prepare: async opts => { calls.push(`prepare:${opts.version}`); return { openai: "/fake/openai", proxy: "/fake/proxy", version: opts.version } },
    log: message => messages.push(message),
  }
  return { dir, config, messages, calls, deps }
}
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

describe("installer transaction (temp dirs, injected preparation; no network/browser)", () => {
  test("preparation precedes backup and atomic write; existing comments survive; repeated install doesn't write", async () => {
    const f = await fixture()
    const original = '{ // keep\n "model": "manual/model", "plugins": ["other"]\n}\n'
    await fs.writeFile(f.config, original, { mode: 0o600 })
    f.deps.prepare = async opts => {
      expect(await fs.readFile(f.config, "utf8")).toBe(original)
      expect(await fs.readdir(f.dir)).toEqual(["opencode.jsonc"])
      return { openai: "/fake/openai", proxy: "/fake/proxy", version: opts.version }
    }
    await install({ host: "auto", dryRun: false }, f.deps)
    expect(f.calls).toEqual(["opencode", "prerequisites"])
    const updated = await fs.readFile(f.config, "utf8")
    expect(updated).toContain("// keep")
    expect(updated).toContain(PACKAGE)
    const files = await fs.readdir(f.dir)
    expect(files.filter(n => n.endsWith(".bak"))).toHaveLength(1)
    expect(files.some(n => n.endsWith(".tmp"))).toBe(false)
    expect(await fs.readFile(path.join(f.dir, files.find(n => n.endsWith(".bak"))!), "utf8")).toBe(original)
    f.deps.prepare = async opts => ({ openai: "fake", proxy: "fake", version: opts.version })
    await install({ host: "v2", dryRun: false }, f.deps)
    expect(await fs.readFile(f.config, "utf8")).toBe(updated)
    expect(await fs.readdir(f.dir)).toEqual(files)
  })
  test("download/checksum failure never writes config, creates backup, or falls back", async () => {
    const f = await fixture()
    const original = '{"plugin":[]}'
    await fs.writeFile(f.config, original)
    f.deps.prepare = async () => { throw new Error("checksum mismatch") }
    await expect(install({ host: "v1", dryRun: false }, f.deps)).rejects.toThrow("checksum mismatch")
    expect(await fs.readFile(f.config, "utf8")).toBe(original)
    expect(await fs.readdir(f.dir)).toEqual(["opencode.jsonc"])
    await fs.rm(f.config)
    await expect(install({ host: "v1", dryRun: false }, f.deps)).rejects.toThrow()
    expect(await fs.readdir(f.dir)).toEqual([])
  })
  test("prerequisite failure also precedes all writes/downloads", async () => {
    const f = await fixture()
    f.deps.prerequisites = async () => { throw new Error("Install Bun") }
    await expect(install({ host: "v2", dryRun: false }, f.deps)).rejects.toThrow("Install Bun")
    expect(await fs.readdir(f.dir)).toEqual([])
    expect(f.calls).toEqual([])
  })
  test("existing custom release/options drive binary preparation", async () => {
    const f = await fixture()
    const source = `{"plugins":[{"package":"${PACKAGE}@0.1.0","options":{"version":"v0.2.0","releasesRepo":"example/bridge","cdpPort":9333}}]}`
    await fs.writeFile(f.config, source)
    f.deps.prepare = async opts => {
      expect(opts.releasesRepo).toBe("example/bridge")
      expect(opts.version).toBe("v0.2.0")
      return { openai: "fake", proxy: "fake", version: opts.version }
    }
    await install({ host: "v2", dryRun: false }, f.deps)
    expect(await fs.readFile(f.config, "utf8")).toBe(source)
  })
  test("dry-run and disabled registration cause zero external calls/writes", async () => {
    const f = await fixture()
    await install({ host: "v1", dryRun: true }, f.deps)
    expect(f.messages.join("\n")).toContain("Exact resulting config")
    expect(f.messages.join("\n")).toContain("checksums.txt")
    expect(f.calls).toEqual([])
    expect(await fs.readdir(f.dir)).toEqual([])
    await expect(install({ host: "auto", dryRun: true }, f.deps)).rejects.toThrow("--host")
    await fs.writeFile(f.config, `{"plugins":[{"package":"${PACKAGE}","disabled":true}]}`)
    await install({ host: "v2", dryRun: false }, f.deps)
    expect(f.calls).toEqual([])
    expect(f.messages.join("\n")).toContain("explicitly disabled")
  })
  test("unknown host, malformed input, multiple global configs and concurrent edits fail closed", async () => {
    const f = await fixture()
    f.deps.version = () => "dev"
    await expect(install({ host: "auto", dryRun: false }, f.deps)).rejects.toThrow("--host")
    await fs.writeFile(f.config, "broken")
    await expect(install({ host: "v1", dryRun: false }, f.deps)).rejects.toThrow("JSON")
    expect(f.calls).toEqual([])
    await fs.writeFile(f.config, "{}")
    await fs.writeFile(path.join(f.dir, "opencode.json"), "{}")
    await expect(install({ host: "v1", dryRun: false }, f.deps)).rejects.toThrow("--config")
    f.deps.prepare = async opts => { await fs.writeFile(f.config, '{"model":"concurrent/edit"}'); return { openai: "fake", proxy: "fake", version: opts.version } }
    await expect(install({ config: f.config, host: "v1", dryRun: false }, f.deps)).rejects.toThrow("changed during")
    expect(await fs.readFile(f.config, "utf8")).toBe('{"model":"concurrent/edit"}')
    expect((await fs.readdir(f.dir)).some(n => n.endsWith(".bak"))).toBe(false)
  })
  test("CLI rejects unknown/missing options", () => {
    for (const args of [[], ["update"], ["install", "--config"], ["install", "--host", "v3"], ["install", "--version", "v1"], ["install", "--dry-run", "--dry-run"]]) expect(() => parseArgs(args)).toThrow()
  })
})

test("actual Node launcher help/dry-run for v1/v2 without Bun/Chrome/network", async () => {
  // Build only the Node installer; the tests never depend on a stale dist.
  const build = spawnSync(process.execPath, ["run", "build:installer"], { cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 10000 })
  expect(build.status).toBe(0)
  const launcher = path.resolve(import.meta.dir, "../bin/opencode-web-bridges.mjs")
  expect((await fs.stat(launcher)).mode & 0o111).not.toBe(0)
  const f = await fixture()
  // Empty PATH proves Node dry-run never needs to execute OpenCode/Bun/Chrome.
  const env = { ...process.env, PATH: "", OPENCODE_CONFIG_DIR: f.dir, CHROME_BIN: "/does/not/exist" }
  const run = (args: string[]) => spawnSync("node", [launcher, ...args], { encoding: "utf8", timeout: 10000 })
  // Resolve node once before stripping PATH for the child.
  const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim()
  expect(node).not.toBe("")
  const help = run(["--help"])
  expect(help.status).toBe(0)
  expect(help.stdout).toContain("npx @bojackduy/opencode-web-bridges install")
  for (const host of ["v1", "v2"]) {
    await fs.writeFile(f.config, `// preserve\n{"${host === "v1" ? "plugin" : "plugins"}": ["other"]}`)
    const result = spawnSync(node, [launcher, "install", "--host", host, "--config", f.config, "--dry-run"], { env, encoding: "utf8", timeout: 10000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("// preserve")
    expect(result.stdout).toContain(PACKAGE)
    expect(await fs.readdir(f.dir)).toEqual(["opencode.jsonc"])
    expect(await fs.readFile(f.config, "utf8")).not.toContain(PACKAGE)
    const sourcePreview = spawnSync(node, [launcher, "install", "--host", host, "--config", f.config, "--build-from-source", "--bridge-ref", "cf04b8f", "--dry-run"], { env, encoding: "utf8", timeout: 10000 })
    expect(sourcePreview.status).toBe(0)
    expect(sourcePreview.stdout).toContain("Source build: bojackduy/chatgpt-proxy@cf04b8f")
    expect(await fs.readdir(f.dir)).toEqual(["opencode.jsonc"])
  }
  const failed = spawnSync(node, [launcher, "install", "--dry-run"], { env, encoding: "utf8", timeout: 10000 })
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain("--host")
})
