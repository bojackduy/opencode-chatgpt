import { describe, expect, test } from "bun:test"
import {
  assetName,
  cacheDir,
  compareVersions,
  currentPlatform,
  downloadURL,
  isWindowsPlatformId,
  releaseBaseURL,
} from "../src/server/binaries"

describe("currentPlatform", () => {
  test("maps supported node platform/arch pairs", () => {
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64")
    expect(currentPlatform("darwin", "x64")).toBe("darwin-amd64")
    expect(currentPlatform("linux", "x64")).toBe("linux-amd64")
    expect(currentPlatform("linux", "arm64")).toBe("linux-arm64")
    expect(currentPlatform("win32", "x64")).toBe("windows-amd64")
    expect(currentPlatform("win32", "arm64")).toBe("windows-arm64")
  })

  test("refuses unsupported platforms with a clear error", () => {
    expect(() => currentPlatform("darwin", "ppc")).toThrow(/unsupported platform/)
    expect(() => currentPlatform("freebsd", "x64")).toThrow(/unsupported platform/)
    expect(() => currentPlatform("win32", "ia32")).toThrow(/unsupported platform win32\/ia32/)
  })

  test("refusal text lists the full supported set", () => {
    let message = ""
    try {
      currentPlatform("sunos", "x64")
    } catch (error) {
      message = (error as Error).message
    }
    for (const id of ["darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"]) {
      expect(message).toContain(id)
    }
  })
})

describe("isWindowsPlatformId", () => {
  test("true only for windows platforms", () => {
    expect(isWindowsPlatformId("windows-amd64")).toBe(true)
    expect(isWindowsPlatformId("windows-arm64")).toBe(true)
    expect(isWindowsPlatformId("darwin-arm64")).toBe(false)
    expect(isWindowsPlatformId("linux-amd64")).toBe(false)
  })
})

describe("assetName", () => {
  test("uses the <binary>-<goos>-<goarch> convention", () => {
    expect(assetName("chatgpt-openai", "darwin-arm64")).toBe("chatgpt-openai-darwin-arm64")
    expect(assetName("chatgpt-proxy", "darwin-amd64")).toBe("chatgpt-proxy-darwin-amd64")
    expect(assetName("chatgpt-openai", "linux-amd64")).toBe("chatgpt-openai-linux-amd64")
    expect(assetName("chatgpt-proxy", "linux-arm64")).toBe("chatgpt-proxy-linux-arm64")
  })

  test("windows assets gain .exe", () => {
    expect(assetName("chatgpt-openai", "windows-amd64")).toBe("chatgpt-openai-windows-amd64.exe")
    expect(assetName("chatgpt-proxy", "windows-amd64")).toBe("chatgpt-proxy-windows-amd64.exe")
    expect(assetName("chatgpt-openai", "windows-arm64")).toBe("chatgpt-openai-windows-arm64.exe")
    expect(assetName("chatgpt-proxy", "windows-arm64")).toBe("chatgpt-proxy-windows-arm64.exe")
  })
})

describe("release URLs", () => {
  test("latest resolves to latest/download", () => {
    expect(releaseBaseURL("misternay/chatgpt-proxy", "latest")).toBe(
      "https://github.com/misternay/chatgpt-proxy/releases/latest/download",
    )
  })

  test("pinned version resolves to download/<tag>", () => {
    expect(downloadURL("misternay/chatgpt-proxy", "v0.2.0", "chatgpt-proxy-linux-amd64")).toBe(
      "https://github.com/misternay/chatgpt-proxy/releases/download/v0.2.0/chatgpt-proxy-linux-amd64",
    )
  })
})

describe("cacheDir", () => {
  test("is versioned under ~/.local/share/opencode-web-bridges", () => {
    expect(cacheDir("v0.2.0")).toMatch(/\.local\/share\/opencode-web-bridges\/v0\.2\.0$/)
    expect(cacheDir("latest")).toMatch(/opencode-web-bridges\/latest$/)
  })

  test("win32 uses %LOCALAPPDATA%/opencode-web-bridges/<version>/", () => {
    const dir = cacheDir("v0.2.0", "win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" })
    expect(dir).toContain("opencode-web-bridges")
    expect(dir).toContain("v0.2.0")
    expect(dir).toContain("C:\\Users\\test\\AppData\\Local")
  })

  test("win32 falls back to ~/AppData/Local without LOCALAPPDATA", () => {
    const dir = cacheDir("v0.2.0", "win32", {})
    expect(dir).toContain("AppData")
    expect(dir).toContain("opencode-web-bridges")
    expect(dir.endsWith("v0.2.0")).toBe(true)
  })

  test("sanitizes unsafe version characters", () => {
    expect(cacheDir("v0.2.0", "win32", { LOCALAPPDATA: "C:\\base" })).toContain("v0.2.0")
    // Slashes are neutralized (no directory escape); dots alone are harmless.
    const dir = cacheDir("../../evil", "linux", {})
    expect(dir.endsWith(".._.._evil")).toBe(true)
  })
})

describe("compareVersions", () => {
  test("orders semantic versions numerically", () => {
    expect(compareVersions("v0.1.0", "v0.2.0")).toBeLessThan(0)
    expect(compareVersions("v0.2.0", "v0.1.0")).toBeGreaterThan(0)
    expect(compareVersions("v0.2.0", "v0.2.0")).toBe(0)
    expect(compareVersions("v0.10.0", "v0.9.0")).toBeGreaterThan(0)
  })

  test("ignores v prefix and compares across it", () => {
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0)
  })

  test("latest sorts above any numbered version", () => {
    expect(compareVersions("latest", "v99.99.99")).toBeGreaterThan(0)
    expect(compareVersions("v0.1.0", "latest")).toBeLessThan(0)
  })
})
