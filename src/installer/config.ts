import { applyEdits, findNodeAtLocation, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser"
import * as os from "node:os"
import * as path from "node:path"

export const PACKAGE = "@bojackduy/opencode-web-bridges"
export type Host = "v1" | "v2"
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const matches = (s: unknown): boolean => typeof s === "string" && (s === PACKAGE || s.startsWith(`${PACKAGE}@`))

/** OpenCode uses xdg-basedir on all platforms, including Windows (not APPDATA). */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

export function hostFromVersion(version: string): Host {
  const match = /^v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(version.trim())
  if (!match) throw new Error("Cannot identify OpenCode v1/v2; pass --host v1 or --host v2 explicitly.")
  return match[1] === "1" ? "v1" : "v2"
}

export interface ConfigPlan {
  source: string
  changed: boolean
  disabled: boolean
  options: Record<string, unknown>
}

/** Append only; jsonc-parser retains all existing entries, comments and unrelated values. */
export function planConfig(source: string, host: Host, optionPatch?: Record<string, unknown>): ConfigPlan {
  const errors: ParseError[] = []
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) throw new Error(`Invalid JSON/JSONC: ${errors.map(e => `${printParseErrorCode(e.error)} at ${e.offset}`).join(", ")}`)
  if (!tree || tree.type !== "object") throw new Error("OpenCode config root must be an object")
  // Duplicate root keys are ambiguous to parsers and unsafe to edit.
  const keys = tree.children?.map(n => n.children?.[0]?.value) ?? []
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate config root keys; repair before installing")
  for (const field of ["$schema", "model"] as const) {
    const node = findNodeAtLocation(tree, [field])
    if (node && node.type !== "string") throw new Error(`${field} must be a string`)
  }
  // The v1 registration hook fills these maps; reject malformed maps rather
  // than adding a plugin that would fail during the next host startup.
  for (const field of ["provider", "mcp"] as const) {
    const node = findNodeAtLocation(tree, [field])
    if (node && node.type !== "object") throw new Error(`${field} must be an object`)
  }
  const key = host === "v1" ? "plugin" : "plugins"
  const other = host === "v1" ? "plugins" : "plugin"
  let existing: { options: Record<string, unknown>; disabled: boolean } | undefined
  let targetIndex = -1
  let targetValue: unknown
  for (const field of ["plugin", "plugins"] as const) {
    const node = findNodeAtLocation(tree, [field])
    if (!node) continue
    if (node.type !== "array") throw new Error(`${field} must be an array`)
    for (const entry of node.children ?? []) {
      // Parse each subtree instead of reserializing the containing array.
      const text = source.slice(entry.offset, entry.offset + entry.length)
      const subtreeErrors: ParseError[] = []
      const subtree = parseTree(text, subtreeErrors, { allowTrailingComma: true })!
      const value = nodeValue(subtree)
      const spec = typeof value === "string" ? value : Array.isArray(value) ? value[0] : object(value) ? value.package : undefined
      const target = matches(spec)
      // An explicitly disabled target is never rewritten or re-enabled, even
      // on hosts whose current public schema does not expose this spelling.
      const disabled = target && object(value) && (value.disabled === true || value.enabled === false)
      const valid = typeof value === "string" || (field === "plugin"
        ? Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && object(value[1])
        : object(value) && typeof value.package === "string" && (value.options === undefined || object(value.options)) && Object.keys(value).every(k => ["package", "options"].includes(k)))
      if (!valid && !disabled) throw new Error(`Invalid ${field} entry; expected ${field === "plugin" ? "string or [package, options]" : "string or {package, options}"}`)
      if (!target) continue
      if (existing) throw new Error("Duplicate ChatGPT plugin entries; repair before installing (options are not merged)")
      if (field === other && !disabled) throw new Error(`ChatGPT is registered in ${other}, but --host ${host} requires ${key}; migrate that entry rather than loading it twice`)
      existing = { disabled, options: Array.isArray(value) ? value[1] as Record<string, unknown> : object(value) && object(value.options) ? value.options : {} }
      targetIndex = node.children!.indexOf(entry)
      targetValue = value
    }
  }
  if (optionPatch && !existing?.disabled) {
    const options = { ...existing?.options, ...optionPatch }
    const spec = typeof targetValue === "string" ? targetValue : Array.isArray(targetValue) ? targetValue[0] : object(targetValue) ? targetValue.package : PACKAGE
    const entry = host === "v1" ? [spec, options] : { package: spec, options }
    if (existing && Object.entries(optionPatch).every(([k, v]) => JSON.stringify(existing!.options[k]) === JSON.stringify(v))) return { source, changed: false, ...existing }
    const array = findNodeAtLocation(tree, [key])
    const edits = modify(source, existing ? [key, targetIndex] : array ? [key, -1] : [key], existing || array ? entry : [entry], {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
    })
    return { source: applyEdits(source, edits), changed: true, disabled: false, options }
  }
  if (existing) return { source, changed: false, ...existing }
  const array = findNodeAtLocation(tree, [key])
  const edits = modify(source, array ? [key, -1] : [key], array ? PACKAGE : [PACKAGE], {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
  })
  return { source: applyEdits(source, edits), changed: true, disabled: false, options: {} }
}

function nodeValue(node: NonNullable<ReturnType<typeof parseTree>>): unknown {
  if (node.type === "object") return Object.fromEntries((node.children ?? []).map(p => [p.children![0]!.value, nodeValue(p.children![1]!)]))
  if (node.type === "array") return (node.children ?? []).map(nodeValue)
  return node.value
}
