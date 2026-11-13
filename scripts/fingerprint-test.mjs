/**
 * The free lane's tool shaping: official vocabulary for the overlapping tools,
 * opaque names for the rest, and the read + shell gate.
 *
 * The old contract (every client tool renamed, all 13 officials appended, every
 * official called a placeholder) is still exercised as the **legacy** path,
 * which the forward listener uses for arbitrary OpenAI/Anthropic clients. The
 * default path is the semantic one: the model sees the official declaration and
 * the response side restores the DSH name and arguments.
 *
 * Run: node scripts/fingerprint-test.mjs
 */

import fs from 'node:fs'
import { applyFingerprint, FINGERPRINT_TOOLS, restoreToolName, O2A_PORTED_VERSION } from '../src/upstream.js'
import { clientToolWireName, CLIENT_TOOL_PREFIX } from '../src/o2a/tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER } from '../src/o2a/official-tools.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const chatTool = (name, extra = {}) => ({
  type: 'function',
  function: { name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra },
})
const flatTool = (name, extra = {}) => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra })
const claudeTool = name => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: { command: { type: 'string' } } } })
const declared = body => (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)
const schemaOf = tool => tool.function?.parameters ?? tool.parameters ?? tool.input_schema
const noteOf = body => JSON.stringify(body.messages?.[0]?.content ?? body.system ?? body.instructions ?? '')
const wireNameOf = name => clientToolWireName(name)

const official = (style, name) => {
  const body = {}
  applyFingerprint(body, style)
  return body.tools.find(tool => (tool.function?.name ?? tool.name) === name)
}

console.log('=== 1. overlapping tools take the official vocabulary; the rest stay opaque ===')
{
  const body = { tools: [chatTool('read'), chatTool('bash'), chatTool('write'), chatTool('custom_tool'), chatTool('subagent')] }
  const map = applyFingerprint(body, false)
  const names = declared(body)
  check('read, shell and write keep their official names', names.slice(0, 3), ['read', 'shell', 'write'])
  check('DSH-only tools are renamed opaquely', names.slice(3), [wireNameOf('custom_tool'), wireNameOf('subagent')])
  check('the read schema is the official one', schemaOf(body.tools[0]).required, ['path'])
  check('the shell schema is the official one', schemaOf(body.tools[1]).required, ['command'])
  check('the DSH bash name is not sent', names.includes('bash'), false)
  check('shell restores to bash', restoreToolName('shell', map), 'bash')
  check('a DSH-only wire name restores to its original', restoreToolName(wireNameOf('subagent'), map), 'subagent')
  check('every executable tool means no placeholder note', /placeholders in this session/.test(noteOf(body)), false)
  check('environment context is still supplied', /<env>/.test(noteOf(body)), true)
}

console.log('\n=== 2. a caller read is replaced, never duplicated ===')
{
  const body = { tools: [chatTool('read'), chatTool('read_client')] }
  const map = applyFingerprint(body, false)
  check('only one declaration carries the read name', declared(body).filter(name => name === 'read').length, 1)
  check('the official read wins', schemaOf(body.tools.find(tool => tool.function.name === 'read')).required, ['path'])
  check('the caller read_client is renamed', declared(body).includes(wireNameOf('read_client')), true)
  check('the renamed caller read_client maps back', restoreToolName(wireNameOf('read_client'), map), 'read_client')
}

console.log('\n=== 3. a body with no tools receives only the gate pair, with a note ===')
{
  const body = {}
  applyFingerprint(body, false)
  check('the gate pair is declared', declared(body), ['read', 'shell'])
  check('read carries the official schema', schemaOf(body.tools[0]).required, ['path'])
  check('shell carries the official schema', schemaOf(body.tools[1]).required, ['command'])
  check('the note names both gate-only tools', /\`read\`/.test(noteOf(body)) && /\`shell\`/.test(noteOf(body)), true)
}

console.log('\n=== 4. tool_choice: never none, retargeted to the wire name, auto on Responses ===')
{
  const chat = { tools: [chatTool('web_search')], tool_choice: 'none' }
  applyFingerprint(chat, false)
  check('a caller none is dropped (the gate refuses it)', chat.tool_choice, undefined)

  const claude = { tools: [claudeTool('web_search')], tool_choice: { type: 'none' } }
  applyFingerprint(claude, 'claude')
  check('the Messages shape drops it too', claude.tool_choice, undefined)

  const named = { tools: [chatTool('web_search')], tool_choice: { type: 'function', function: { name: 'web_search' } } }
  applyFingerprint(named, false)
  check('a choice naming a renamed tool follows the wire name', named.tool_choice.function.name, 'websearch')

  const flat = { tools: [flatTool('write')] }
  applyFingerprint(flat, true)
  check('Responses defaults to auto', flat.tool_choice, 'auto')
}

console.log('\n=== 5. the Messages and Responses shapes use their own wrappers ===')
{
  const claude = { tools: [claudeTool('read')] }
  applyFingerprint(claude, 'claude')
  const claudeRead = claude.tools.find(tool => tool.name === 'read')
  check('the Messages read carries input_schema', claudeRead.input_schema.required, ['path'])
  check('…and no parameters field', claudeRead.parameters, undefined)
  check('the Messages gate pair is present', ['read', 'shell'].every(name => declared(claude).includes(name)), true)

  const flat = { tools: [flatTool('web_search')] }
  applyFingerprint(flat, true)
  const flatSearch = flat.tools.find(tool => tool.name === 'websearch')
  check('the Responses search is flat', flatSearch.function, undefined)
  check('…and carries the official query schema', flatSearch.parameters.required, ['query'])
}

console.log('\n=== 6. the mapped definitions are byte-for-byte the official ones ===')
{
  const captured = JSON.parse(fs.readFileSync(new URL('../src/o2a/assets/opencode_tools.json', import.meta.url), 'utf8'))
  const body = {
    tools: [
      chatTool('read'), chatTool('bash'), chatTool('edit'), chatTool('write'), chatTool('glob'),
      chatTool('grep'), chatTool('skill'), chatTool('web_search'), chatTool('web_fetch'),
      chatTool('ask_user_question'), chatTool('todo_write'),
    ],
  }
  applyFingerprint(body, false)
  const sent = name => body.tools.find(tool => tool.function.name === name).function
  const win32Shell = captured.shell.description.replace('on Linux using bash', 'on Windows using powershell')
  for (const name of ['read', 'edit', 'write', 'glob', 'grep', 'skill', 'websearch', 'webfetch', 'question']) {
    const want = captured[name]
    const got = sent(name)
    check(`${name} equals its captured definition`, {
      description: got.description,
      parameters: got.parameters,
    }, {
      description: want.description,
      parameters: want.parameters,
    })
  }
  const shell = sent('shell')
  check('shell equals its captured definition (platform-aware)', shell.description, process.platform === 'win32' ? win32Shell : captured.shell.description)
  check('shell schema equals the captured one', shell.parameters, captured.shell.parameters)

  const todo = sent('todowrite')
  check('todowrite has a real definition', todo.description.startsWith('Create and update a todo list'), true)
  check('todowrite status enum is the official four-state one', todo.parameters.properties.todos.items.properties.status.enum, ['pending', 'in_progress', 'completed', 'cancelled'])

  check('patch and execute are never declared', ['patch', 'execute'].some(name => declared(body).includes(name)), false)
  check('the gate names are read + shell', [...FINGERPRINT_TOOLS], ['read', 'shell'])
}

console.log('\n=== 7. shaping twice is a no-op (idempotence) ===')
{
  const body = { tools: [chatTool('read'), chatTool('bash'), chatTool('pwsh')] }
  applyFingerprint(body, false)
  const once = JSON.stringify(body)
  const secondMap = applyFingerprint(body, false)
  check('the second pass changes nothing', JSON.stringify(body), once)
  check('the second pass renames nothing', secondMap.size, 0)
}

console.log('\n=== 8. the legacy path still serves the forward listener ===')
{
  const body = { tools: [chatTool('pwsh')] }
  applyFingerprint(body, false, { toolSemantics: false })
  const names = declared(body)
  check('legacy renames the caller tool', names.includes(wireNameOf('pwsh')), true)
  check('legacy appends all 13 official tools', V2_OFFICIAL_TOOL_ORDER.every(name => names.includes(name)), true)
  check('legacy keeps the placeholder note', /placeholders in this session/.test(noteOf(body)), true)
  check('legacy declares no DSH bash', names.includes('bash'), false)
}

console.log('\n=== 9. the port names the release it mirrors ===')
{
  check('the ported reference version is pinned', /^\d+\.\d+\.\d+$/.test(O2A_PORTED_VERSION), true)
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
