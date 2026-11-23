/** Render authored transport tool contracts in each supported wire format. */
import { officialToolsText } from './asset-source.js'

/**
 * The 13 tools the official 2.2.3 client declares, in the order this lane sends
 * them (alphabetical, so the body is byte-stable across runs).
 *
 * The set is not free choice: `read` and `shell` are the two the free tier
 * validates the definition of, and the rest are what makes the request read as a
 * CLI agent session. `execute` used to sit here — it belongs to an older client
 * generation and 2.2.3 does not ship it — and `todowrite` was missing. Both are
 * corrected against the tag pinned in `src/o2a/version.js`.
 */
export const V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  'edit', 'glob', 'grep', 'patch', 'question', 'read', 'shell',
  'skill', 'subagent', 'todowrite', 'webfetch', 'websearch', 'write',
])
let definitions
export function officialToolDefinition(name) {
  definitions ??= new Map(Object.entries(JSON.parse(officialToolsText())))
  return definitions.get(name)
}

export function v2ShellDescription(base, platform = process.platform) {
  if (platform !== 'win32') return base
  return base.replace('on Linux using bash', 'on Windows using powershell')
}

export function officialTool(shape, name) {
  const definition = officialToolDefinition(name)
  let description = definition?.description ?? `Agent tool ${name}`
  const parameters = definition?.parameters == null ? { type: 'object', properties: {} } : structuredClone(definition.parameters)
  if (name === 'shell') description = v2ShellDescription(description)
  if (shape === 'claude') return { name, description, input_schema: parameters }
  const fn = { name, description, parameters }
  return shape === 'flat' ? { type: 'function', ...fn } : { type: 'function', function: { ...fn, strict: false } }
}

export function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map(name => officialTool(shape, name))
}

export function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (shape !== 'chat') {
    const type = typeof entry.type === 'string' ? entry.type : ''
    if (shape === 'flat' && !['', 'function', 'custom'].includes(type)) return null
    if (shape === 'claude' && !['', 'custom'].includes(type)) return null
  }
  const name = shape === 'chat' ? entry.function?.name : entry.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

export function isExactOfficialDefinition(entry, name, shape = 'chat') {
  const wrapper = shape === 'chat' ? (entry?.function ?? entry) : entry
  if (!wrapper || typeof wrapper !== 'object') return false
  const rendered = officialTool(shape, name)
  const target = shape === 'chat' ? (rendered?.function ?? rendered) : rendered
  if (!target) return false
  const schema = shape === 'claude' ? wrapper.input_schema : wrapper.parameters
  const targetSchema = shape === 'claude' ? target.input_schema : target.parameters
  return wrapper.description === target.description
    && JSON.stringify(schema) === JSON.stringify(targetSchema)
}

