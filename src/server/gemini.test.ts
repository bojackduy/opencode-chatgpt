import { expect, test } from "bun:test"
import { applyGeminiConfig, resolveGemini, registerGeminiV2Provider, registerGeminiV2Mcp } from "./gemini"
import { setup } from "./v2"
import plugin from "./plugin"

test("Gemini is opt-in and requires a local binary", () => {
  expect(resolveGemini(undefined)).toBeUndefined()
  expect(resolveGemini(false)).toBeUndefined()
  expect(() => resolveGemini({})).toThrow("absolute")
  expect(() => resolveGemini({ proxyBinary: "/local/proxy", adapterBaseURL: "http://remote/v1" })).toThrow()
})
test("v1 fill-missing preserves manual entries and default model", () => {
  const o = resolveGemini({ proxyBinary: "/local path/proxy" })!
  const cfg: any = { model: "other/model", provider: { "chatgpt-web": { manual: true } } }
  applyGeminiConfig(cfg, o)
  expect(cfg.provider["gemini-web"].models["gemini-web"].modalities.input).toEqual(["text"])
  expect(cfg.mcp.gemini.command[0]).toBe("/local path/proxy")
  const saved = JSON.stringify(cfg)
  applyGeminiConfig(cfg, o)
  expect(JSON.stringify(cfg)).toBe(saved)
  expect(cfg.model).toBe("other/model")
})
test("v2 registration uses v2 package, matching ids, and preserves existing entries", () => {
  const o = resolveGemini({ proxyBinary: "/local/proxy" })!
  let added: any; let mcp: any
  registerGeminiV2Provider({ get: () => undefined, add: v => { added = v } }, o)
  expect(added.info.package).toBe("@opencode/ai/providers/openai-compatible")
  expect(added.models[0].providerID).toBe("gemini-web")
  expect(added.models[0].modelID).toBe("gemini-web")
  registerGeminiV2Mcp({ get: () => undefined, set: (_, v) => { mcp = v } }, o)
  expect(mcp.command).toEqual(["/local/proxy", "-chrome-port", "9223", "-profile", o.profileDir])
  registerGeminiV2Provider({ get: () => true, add: () => { throw new Error("clobbered") } }, o)
  registerGeminiV2Mcp({ get: () => true, set: () => { throw new Error("clobbered") } }, o)
})

test("Gemini-only entries skip ChatGPT binary management on both hosts", async () => {
  const options = { chatgpt: false, gemini: { proxyBinary: "/local/proxy" } }
  const hooks = await plugin.server({} as any, options)
  const cfg: any = {}
  await hooks.config!(cfg)
  expect(Object.keys(cfg.provider)).toEqual(["gemini-web"])
  const providers: string[] = []; const mcps: string[] = []
  await setup({ options,
    provider: { transform: async (f: any) => f({ get: () => undefined, add: (v: any) => providers.push(v.info.id) }) },
    mcp: { transform: async (f: any) => f({ get: () => undefined, set: (id: string) => mcps.push(id) }) },
  } as any)
  expect(providers).toEqual(["gemini-web"])
  expect(mcps).toEqual(["gemini"])
})
