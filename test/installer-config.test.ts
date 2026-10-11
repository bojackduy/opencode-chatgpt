import { describe, expect, test } from "bun:test"
import { globalConfigDir, hostFromVersion, PACKAGE, planConfig } from "../src/installer/config"

describe("installer config planning (no IO)", () => {
  test("paths follow OpenCode's XDG contract, including Windows", () => {
    expect(globalConfigDir({}, "/home/user")).toBe("/home/user/.config/opencode")
    expect(globalConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode")
    expect(globalConfigDir({ OPENCODE_CONFIG_DIR: "/explicit", XDG_CONFIG_HOME: "/xdg" })).toBe("/explicit")
  })
  test("version detection fails closed", () => {
    expect(hostFromVersion("1.18.30\n")).toBe("v1")
    expect(hostFromVersion("v2.0.11-beta.1")).toBe("v2")
    for (const v of ["dev", "3.0.0", "OpenCode 2", ""]) expect(() => hostFromVersion(v)).toThrow("--host")
  })
  for (const host of ["v1", "v2"] as const) {
    test(`${host}: comments, manual entries and default model preserved; idempotent`, () => {
      const key = host === "v1" ? "plugin" : "plugins"
      const source = `// header\n{\n  "model": "manual/model", // keep model\n  "provider": {"custom": {}},\n  "mcp": {"manual": {}},\n  "${key}": [\n    // plugin comment\n    "other",\n  ],\n}\n`
      const plan = planConfig(source, host)
      expect(plan.changed).toBe(true)
      for (const s of ["// header", "// keep model", "// plugin comment", '"provider": {"custom": {}}', '"mcp": {"manual": {}}', '"other"']) expect(plan.source).toContain(s)
      expect(plan.source).toContain(PACKAGE)
      expect(planConfig(plan.source, host)).toEqual({ ...plan, changed: false })
    })
    test(`${host}: existing pin/options retained byte-for-byte`, () => {
      const entry = host === "v1" ? `["${PACKAGE}@0.1.0", {"version":"v0.2.0", "cdpPort":9333}]` : `{"package":"${PACKAGE}@0.1.0", "options":{"version":"v0.2.0", "cdpPort":9333}}`
      const source = `{ "${host === "v1" ? "plugin" : "plugins"}": [${entry}] }`
      expect(planConfig(source, host)).toEqual({ source, changed: false, disabled: false, options: { version: "v0.2.0", cdpPort: 9333 } })
    })
  }
  test("disabled target stays disabled", () => {
    const source = `{"plugins":[{"package":"${PACKAGE}","disabled":true}]}`
    expect(planConfig(source, "v2")).toEqual({ source, changed: false, disabled: true, options: {} })
  })
  test("malformed or ambiguous config fails safely", () => {
    for (const source of ["{", "[]", '{"$schema":false}', '{"model":42}', '{"provider":[]}', '{"mcp":false}', '{"plugin":false}', '{"plugin":[42]}', '{"plugins":[["x",{}]]}', '{"plugin":[],"plugin":[]}', `{"plugin":["${PACKAGE}","${PACKAGE}@latest"]}`, `{"plugin":["${PACKAGE}"]}`]) {
      expect(() => planConfig(source, "v2")).toThrow()
    }
  })
})
