import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { disposeMode, findChromeBinary, chromeCandidates } from "../src/server/supervisor"

const tmpRoots: string[] = []

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function mktemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-supervisor-test-"))
  tmpRoots.push(dir)
  return dir
}

describe("disposeMode", () => {
  test("win32 uses plain child kill (no POSIX process groups)", () => {
    expect(disposeMode("win32")).toBe("plain")
  })

  test("posix platforms keep the process-group kill", () => {
    expect(disposeMode("darwin")).toBe("process-group")
    expect(disposeMode("linux")).toBe("process-group")
  })
})

describe("findChromeBinary on win32", () => {
  test("finds chrome via injected PROGRAMFILES without an exec bit (F_OK, not X_OK)", () => {
    const root = mktemp()
    const pf = path.join(root, "Program Files")
    const chrome = path.join(pf, "Google", "Chrome", "Application", "chrome.exe")
    fs.mkdirSync(path.dirname(chrome), { recursive: true })
    // 0o644 deliberately: no exec bit. Must still be found on win32, where
    // executability is the .exe extension rather than a mode bit.
    fs.writeFileSync(chrome, "fake", { mode: 0o644 })
    const found = findChromeBinary("win32", {
      PROGRAMFILES: pf,
      "PROGRAMFILES(X86)": path.join(root, "PF86-missing"),
      LOCALAPPDATA: path.join(root, "LA-missing"),
    })
    expect(found).toBe(chrome)
  })

  test("prefers 64-bit Program Files over x86 and per-user installs", () => {
    const root = mktemp()
    const pf64 = path.join(root, "PF")
    const pf86 = path.join(root, "PF86")
    const la = path.join(root, "LA")
    for (const base of [pf64, pf86, la]) {
      const chrome = path.join(base, "Google", "Chrome", "Application", "chrome.exe")
      fs.mkdirSync(path.dirname(chrome), { recursive: true })
      fs.writeFileSync(chrome, "fake")
    }
    const found = findChromeBinary("win32", {
      PROGRAMFILES: pf64,
      "PROGRAMFILES(X86)": pf86,
      LOCALAPPDATA: la,
    })
    expect(found).toBe(path.join(pf64, "Google", "Chrome", "Application", "chrome.exe"))
  })

  test("falls back to the x86 install dir when 64-bit is absent", () => {
    const root = mktemp()
    const pf86 = path.join(root, "PF86")
    const chrome = path.join(pf86, "Google", "Chrome", "Application", "chrome.exe")
    fs.mkdirSync(path.dirname(chrome), { recursive: true })
    fs.writeFileSync(chrome, "fake")
    const found = findChromeBinary("win32", {
      PROGRAMFILES: path.join(root, "PF-missing"),
      "PROGRAMFILES(X86)": pf86,
      LOCALAPPDATA: path.join(root, "LA-missing"),
    })
    expect(found).toBe(chrome)
  })

  test("falls back to the per-user LOCALAPPDATA install", () => {
    const root = mktemp()
    const la = path.join(root, "LA")
    const chrome = path.join(la, "Google", "Chrome", "Application", "chrome.exe")
    fs.mkdirSync(path.dirname(chrome), { recursive: true })
    fs.writeFileSync(chrome, "fake")
    const found = findChromeBinary("win32", {
      PROGRAMFILES: path.join(root, "PF-missing"),
      "PROGRAMFILES(X86)": path.join(root, "PF86-missing"),
      LOCALAPPDATA: la,
    })
    expect(found).toBe(chrome)
  })

  test("CHROME_BIN override is honored when no install exists", () => {
    const found = findChromeBinary("win32", {
      PROGRAMFILES: "Z:\\no-such-dir-pf",
      "PROGRAMFILES(X86)": "Z:\\no-such-dir-pf86",
      LOCALAPPDATA: "Z:\\no-such-dir-la",
      CHROME_BIN: "D:\\Tools\\chrome.exe",
    })
    expect(found).toBe("D:\\Tools\\chrome.exe")
  })

  test("returns undefined when nothing is installed and no override is set", () => {
    const found = findChromeBinary("win32", {
      PROGRAMFILES: "Z:\\no-such-dir-pf",
      "PROGRAMFILES(X86)": "Z:\\no-such-dir-pf86",
      LOCALAPPDATA: "Z:\\no-such-dir-la",
      CHROME_BIN: "",
    })
    expect(found).toBeUndefined()
  })
})

describe("findChromeBinary on posix", () => {
  test("linux candidates include distro, /opt, /usr/local, snap, and ~/.local layouts", () => {
    const cands = chromeCandidates("linux", {})
    for (const expected of [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/opt/google/chrome/google-chrome",
      "/opt/google/chrome/chrome",
      "/usr/local/bin/google-chrome",
      "/usr/local/bin/chromium",
      "/snap/bin/chromium",
      "/snap/bin/google-chrome",
    ]) {
      expect(cands).toContain(expected)
    }
    expect(cands.some((c) => c.endsWith(path.join(".local", "bin", "google-chrome")))).toBe(true)
    expect(cands.some((c) => c.endsWith(path.join(".local", "bin", "chromium")))).toBe(true)
  })

  test("darwin candidates cover system + user app bundles", () => {
    const cands = chromeCandidates("darwin", {})
    expect(cands).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    expect(cands).toContain("/Applications/Chromium.app/Contents/MacOS/Chromium")
  })

  test("win32 candidates derive from PROGRAMFILES / LOCALAPPDATA env", () => {
    const cands = chromeCandidates("win32", {
      PROGRAMFILES: "D:\\PF",
      "PROGRAMFILES(X86)": "D:\\PF86",
      LOCALAPPDATA: "D:\\LA",
    })
    expect(cands).toContain(path.join("D:\\PF", "Google", "Chrome", "Application", "chrome.exe"))
    expect(cands).toContain(path.join("D:\\PF86", "Google", "Chrome", "Application", "chrome.exe"))
    expect(cands).toContain(path.join("D:\\LA", "Google", "Chrome", "Application", "chrome.exe"))
  })
})
