/**
 * End-to-end tool semantics for the free lane.
 *
 * The adapter is the only place where the outbound declaration, the wire call
 * and the host-facing block meet. This suite drives the real adapter against a
 * scripted fetch so a mismatch between the three cannot hide behind a unit test
 * of the map alone.
 *
 * Run: node scripts/tool-semantics-wire-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-tool-semantics-'))
const oldHome = process.env.DSH_HOME
const oldMode = process.env.OUR_FREE_MODEL_FREE_TRANSPORT
const oldFetch = globalThis.fetch
process.env.DSH_HOME = scratch
process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const model = 'deepseek-v4.1-flash-free'
const toolsOf = names => names.map(name => ({
  name,
  description: `host ${name}`,
  parameters: { type: 'object', properties: { x: { type: 'string' } } },
}))

const chatFrames = calls => {
  const frames = []
  if (calls.length > 0) {
    frames.push('data: ' + JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: null,
      }],
    }) + '\n\n')
  } else {
    frames.push('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }) + '\n\n')
  }
  frames.push('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }] }) + '\n\n')
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

try {
  const { FreeModelAdapter } = await import('../src/adapter.js')
  const { buildCatalog } = await import('../src/catalog.js')
  const { clientToolWireName } = await import('../src/o2a/tool-renames.js')
  const catalog = buildCatalog([model])
  const snapshot = { catalog, membership: {}, settings: { enabled: true, streamRecovery: false } }
  const adapter = new FreeModelAdapter({ state: () => snapshot, recordUsage() {} })

  let lastPayload
  let nextCalls = []
  globalThis.fetch = async (_url, init) => {
    lastPayload = JSON.parse(init.body)
    return new Response(chatFrames(nextCalls), { headers: { 'content-type': 'text/event-stream' } })
  }

  const run = async (tools) => {
    const chunks = []
    for await (const chunk of adapter.runSingle({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools,
      sessionId: 'tool-semantics-test-' + Math.random(),
      signal: AbortSignal.timeout(5000),
    }, catalog[0], snapshot)) chunks.push(chunk)
    return chunks
  }

  // 1. Outbound: the host declarations become the official vocabulary, and all
  //    13 official tools are present to satisfy upstream whitelist fingerprints.
  nextCalls = []
  await run(toolsOf(['bash', 'edit', 'web_search', 'ask_user_question', 'todo_write', 'custom_tool', 'mcp__github__search']))
  const outbound = lastPayload.tools.map(tool => tool.function.name)
  const expectedOutbound = ['shell', 'edit', 'websearch', 'question', 'todowrite', clientToolWireName('custom_tool'), 'mcp__github__search', 'read']
  check('outbound names', outbound, expectedOutbound)
  check('custom_tool is renamed to mcp_ wire name', outbound.includes(clientToolWireName('custom_tool')), true)
  check('real MCP tool name preserves its full shape', outbound.includes('mcp__github__search'), true)
  check('the DSH bash name is gone', outbound.includes('bash'), false)
  check('edit carries the official schema', lastPayload.tools.find(tool => tool.function.name === 'edit').function.parameters.required, ['path', 'oldString', 'newString'])
  check('the gate read is official', lastPayload.tools.find(tool => tool.function.name === 'read').function.parameters.required, ['path'])
  check('the DSH-only tool keeps its own description', lastPayload.tools.find(tool => tool.function.name === clientToolWireName('custom_tool')).function.description, 'host custom_tool')

  // 2. Inbound: shell and edit are restored with the DSH argument keys.
  nextCalls = [
    { id: 'c1', name: 'shell', args: { command: 'ls', workdir: '/tmp', timeout: 0, background: true } },
    { id: 'c2', name: 'edit', args: { path: '/a', oldString: 'a', newString: 'b', replaceAll: true } },
  ]
  {
    const chunks = await run(toolsOf(['bash', 'edit']))
    const calls = chunks.filter(chunk => chunk.block?.type === 'tool-call').map(chunk => chunk.block)
    check('both calls close', calls.length, 2)
    const shell = calls.find(call => call.name === 'bash')
    check('shell restores to bash', shell !== undefined, true)
    check('shell arguments are DSH-shaped', JSON.parse(shell.arguments), {
      description: 'ls', command: 'ls', workdir: '/tmp', run_in_background: true,
    })
    const edit = calls.find(call => call.name === 'edit')
    check('edit arguments are DSH-shaped', JSON.parse(edit.arguments), {
      file_path: '/a', old_string: 'a', new_string: 'b', replace_all: true,
    })
  }

  // 3. Inbound: the single-argument tools are wrapped/renamed.
  nextCalls = [
    { id: 'c1', name: 'websearch', args: { query: 'q' } },
    { id: 'c2', name: 'question', args: { questions: [{ question: 'Pick', header: 'H', options: [{ label: 'A', description: 'a' }], multiple: true }] } },
    { id: 'c3', name: 'todowrite', args: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'cancelled' }] } },
  ]
  {
    const chunks = await run(toolsOf(['web_search', 'ask_user_question', 'todo_write']))
    const calls = chunks.filter(chunk => chunk.block?.type === 'tool-call').map(chunk => chunk.block)
    const byName = Object.fromEntries(calls.map(call => [call.name, call]))
    check('websearch restores to web_search', byName.web_search !== undefined, true)
    check('websearch wraps its query', JSON.parse(byName.web_search.arguments), { queries: ['q'] })
    check('question restores to ask_user_question', byName.ask_user_question !== undefined, true)
    check('question gains an id and multi_select', JSON.parse(byName.ask_user_question.arguments), {
      questions: [{ id: 'q0', question: 'Pick', header: 'H', options: [{ label: 'A', description: 'a' }], multi_select: true }],
    })
    check('todowrite restores to todo_write', byName.todo_write !== undefined, true)
    check('todowrite drops cancelled and the extra in_progress', JSON.parse(byName.todo_write.arguments), {
      todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }],
    })
  }
  // 4. Inbound: host-spelled arguments (the model imitating history) survive.
  //    Captured live 2026-11-13: read/write lost their file_path and the host
  //    rejected every call with INVALID_ARGS.
  nextCalls = [
    { id: 'c1', name: 'read', args: { file_path: '/a/b.js', offset: 40, limit: 130 } },
    { id: 'c2', name: 'write', args: { file_path: '/a/b.js', content: 'hi' } },
  ]
  {
    const chunks = await run(toolsOf(['read', 'write']))
    const calls = chunks.filter(chunk => chunk.block?.type === 'tool-call').map(chunk => chunk.block)
    const byName = Object.fromEntries(calls.map(call => [call.name, call]))
    check('host-spelled read keeps its path', JSON.parse(byName.read.arguments), {
      file_path: '/a/b.js', offset: 40, limit: 130,
    })
    check('host-spelled write keeps its path', JSON.parse(byName.write.arguments), {
      file_path: '/a/b.js', content: 'hi',
    })
  }

  // 5. Inbound: genuine MCP tool names are preserved completely without truncation.
  nextCalls = [
    { id: 'c1', name: 'mcp__github__search', args: { query: 'test' } },
  ]
  {
    const chunks = await run(toolsOf(['mcp__github__search']))
    const calls = chunks.filter(chunk => chunk.block?.type === 'tool-call').map(chunk => chunk.block)
    check('real MCP tool call restores intact', calls[0]?.name, 'mcp__github__search')
    check('real MCP tool is not truncated to _github__search', calls[0]?.name !== '_github__search', true)
  }
} finally {
  globalThis.fetch = oldFetch
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  if (oldMode === undefined) delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT
  else process.env.OUR_FREE_MODEL_FREE_TRANSPORT = oldMode
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\ntool semantics: outbound and inbound agree' : `\ntool semantics: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
