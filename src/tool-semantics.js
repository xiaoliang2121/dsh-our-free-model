/**
 * Free-lane tool vocabulary for dsh-llm-our-free-model.
 *
 * The lane's gate requires the official OpenCode tool declarations (13 tools)
 * byte-for-byte identical to the official client, plus todowrite.
 *
 * Rules:
 * 1. Official names only carry official definitions: colliding declarations that do
 *    not match official definitions byte-for-byte retreat to mcp_<hash>.
 * 2. Non-official / caller-defined tools wrap as mcp_<hash>.
 * 3. Genuine MCP tool names (e.g. mcp__*, mcp_*) preserve their full shape without truncation.
 * 4. Missing official 13 tools are injected verbatim.
 * 5. Inbound arguments are translated back to DSH conventions.
 *
 * @module src/tool-semantics
 */

import {
  CLIENT_TOOL_PREFIX,
  ToolRenameMap,
  clientToolWireName,
  isWireToolName,
  renamableToolName,
  officialTool,
  V2_OFFICIAL_TOOL_ORDER,
  isExactOfficialDefinition,
} from './o2a.js'

/** DSH tool name -> official tool name. */
const OFFICIAL_BY_DSH = Object.freeze({
  read: 'read',
  edit: 'edit',
  write: 'write',
  glob: 'glob',
  grep: 'grep',
  skill: 'skill',
  web_search: 'websearch',
  web_fetch: 'webfetch',
  ask_user_question: 'question',
  todo_write: 'todowrite',
  bash: 'shell',
})

/** Official name -> DSH name, for idempotence on an already-shaped body. */
const DSH_BY_OFFICIAL = Object.freeze(Object.fromEntries(
  Object.entries(OFFICIAL_BY_DSH).map(([dsh, official]) => [official, dsh]),
))

export function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith(CLIENT_TOOL_PREFIX) && !isWireToolName(name)
}

/** Rename one declaration on its wire-specific wrapper. */
function withName(shape, entry, wireName) {
  if (shape === 'chat') return { ...entry, function: { ...entry.function, name: wireName } }
  return { ...entry, name: wireName }
}

/** Characters that change the meaning of a regular expression. */
const REGEXP_SPECIALS = '.*+?^' + '$' + '{}()|[]' + '\\'

function escapeRegExp(value) {
  let out = ''
  for (const char of value) out += REGEXP_SPECIALS.includes(char) ? '\\' + char : char
  return out
}

function shellDescriptionFor(command) {
  const text = typeof command === 'string' ? command.trim() : ''
  if (text === '') return 'Run shell command'
  const words = text.split(/\s+/).slice(0, 8).join(' ')
  return words.length > 80 ? words.slice(0, 77) + '...' : words
}

/** First value that is a string; official spelling before the DSH fallback. */
function stringOr(...values) {
  for (const value of values) {
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Map an option list from either vocabulary onto the DSH shape. */
function optionList(value) {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((option) => option !== null && typeof option === 'object')
    .map((option) => ({
      label: option.label,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    }))
    .filter((option) => typeof option.label === 'string' && option.label !== '')
}

/** Official -> DSH argument translation, one entry per mapped official name. */
const INBOUND = {
  read(args) {
    const out = {}
    const path = stringOr(args.path, args.file_path)
    if (path !== undefined) out.file_path = path
    for (const key of ['offset', 'limit']) {
      const value = Number(args[key])
      if (Number.isInteger(value) && value >= 1) out[key] = value
    }
    return out
  },

  edit(args) {
    const out = {}
    const path = stringOr(args.path, args.file_path)
    if (path !== undefined) out.file_path = path
    const oldString = stringOr(args.oldString, args.old_string)
    if (oldString !== undefined) out.old_string = oldString
    const newString = stringOr(args.newString, args.new_string)
    if (newString !== undefined) out.new_string = newString
    const replaceAll = typeof args.replaceAll === 'boolean' ? args.replaceAll : args.replace_all
    if (typeof replaceAll === 'boolean') out.replace_all = replaceAll
    return out
  },

  write(args) {
    const out = {}
    const path = stringOr(args.path, args.file_path)
    if (path !== undefined) out.file_path = path
    if (typeof args.content === 'string') out.content = args.content
    return out
  },

  glob(args) {
    const out = {}
    if (typeof args.pattern === 'string') out.pattern = args.pattern
    if (typeof args.path === 'string') out.path = args.path
    return out
  },

  grep(args) {
    const out = {}
    if (typeof args.pattern === 'string') {
      let pattern = args.pattern
      if (args.literal === true) pattern = escapeRegExp(pattern)
      if (args.caseSensitive === false) pattern = '(?i)' + pattern
      out.pattern = pattern
    }
    if (typeof args.path === 'string') out.path = args.path
    if (typeof args.include === 'string') out.include = args.include
    return out
  },

  skill(args) {
    const out = {}
    const id = stringOr(args.id, args.name)
    if (id !== undefined) out.name = id
    return out
  },

  websearch(args) {
    if (Array.isArray(args.queries)) {
      return { queries: args.queries.filter((query) => typeof query === 'string') }
    }
    return { queries: typeof args.query === 'string' ? [args.query] : [] }
  },

  webfetch(args) {
    const out = {}
    if (typeof args.url === 'string') out.url = args.url
    return out
  },

  question(args) {
    const questions = Array.isArray(args.questions) ? args.questions : []
    return {
      questions: questions.map((raw, index) => {
        const source = raw !== null && typeof raw === 'object' ? raw : {}
        const options = optionList(source.options)
        const dshShaped = typeof source.id === 'string' || source.multi_select === true
        const out = {
          id: dshShaped && typeof source.id === 'string' ? source.id : 'q' + String(index),
          question: source.question,
        }
        if (typeof source.header === 'string') out.header = source.header
        if (options !== undefined) out.options = options
        if (dshShaped ? source.multi_select === true : source.multiple === true) out.multi_select = true
        return out
      }),
    }
  },

  todowrite(args) {
    const source = Array.isArray(args.todos) ? args.todos : []
    const seen = new Set()
    const todos = []
    let active = 0
    for (const raw of source) {
      if (raw === null || typeof raw !== 'object') continue
      const content = typeof raw.content === 'string' ? raw.content.trim() : ''
      if (content === '' || seen.has(content)) continue
      if (raw.status === 'cancelled') continue
      let status = raw.status
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') status = 'pending'
      if (status === 'in_progress') {
        if (active > 0) status = 'pending'
        else active += 1
      }
      seen.add(content)
      todos.push({ content, status })
    }
    return { todos }
  },

  shell(args) {
    const out = {}
    const description = stringOr(args.description)
    out.description = description !== undefined && description.trim() !== ''
      ? description
      : shellDescriptionFor(args.command)
    if (typeof args.command === 'string') out.command = args.command
    if (typeof args.workdir === 'string') out.workdir = args.workdir
    const timeout = Number(args.timeout)
    if (Number.isFinite(timeout) && timeout > 0) out.timeoutMs = Math.trunc(timeout)
    else {
      const timeoutMs = Number(args.timeoutMs)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) out.timeoutMs = Math.trunc(timeoutMs)
    }
    if (args.background === true || args.run_in_background === true) out.run_in_background = true
    return out
  },
}

/**
 * Shape the outbound tool list and return the response-side plan.
 *
 * @param body - the request body; `body.tools` is replaced.
 * @param shape - 'chat' | 'flat' | 'claude'.
 * @returns `{ renames, semantics, injected }`:
 *   renames is the ToolRenameMap for name restoration;
 *   semantics is a Map keyed by DSH name for argument translation;
 *   injected lists gate-only official names that need the placeholder note.
 */
export function shapeOfficialToolset(body, shape) {
  const source = Array.isArray(body.tools) ? body.tools : []
  const renames = new ToolRenameMap()
  const semantics = new Map()
  const shaped = []
  const used = new Set()

  for (const tool of source) {
    const name = renamableToolName(shape, tool)
    if (name === null) {
      shaped.push(tool)
      continue
    }

    const officialName = OFFICIAL_BY_DSH[name]
    if (officialName !== undefined) {
      // DSH 工具映射到官方名称（例如 bash -> shell, edit -> edit, web_search -> websearch 等）
      if (used.has(officialName)) {
        const wire = clientToolWireName(name, used)
        renames.add(name, wire)
        shaped.push(withName(shape, tool, wire))
        used.add(wire)
        continue
      }
      const rendered = officialTool(shape, officialName)
      if (rendered !== undefined && rendered !== null) {
        shaped.push(rendered)
        if (officialName !== name) renames.add(name, officialName)
        semantics.set(name, INBOUND[officialName])
        used.add(officialName)
        continue
      }
    }

    // 已经具有官方名称的工具（例如调用方直接传 edit/shell/read 等）：
    // 若定义与官方逐字一致，则保留并建立映射；若不一致（同名异质），必须退避为 mcp_<hash>
    if (V2_OFFICIAL_TOOL_ORDER.includes(name)) {
      if (isExactOfficialDefinition(tool, name, shape) && !used.has(name)) {
        shaped.push(tool)
        if (INBOUND[name]) semantics.set(name, INBOUND[name])
        used.add(name)
        continue
      }
      // 撞名异质工具：退避为 mcp_<hash>
      const wire = clientToolWireName(name, used)
      renames.add(name, wire)
      shaped.push(withName(shape, tool, wire))
      used.add(wire)
      continue
    }

    // 真实的 MCP 工具名（例如 mcp__github__search）：保留完整形状，不被误判为 generated wire name
    if (isMcpToolName(name)) {
      shaped.push(tool)
      used.add(name)
      continue
    }

    // 幂等性防护：若已经是上一轮生成的合法 wire name
    if (isWireToolName(name)) {
      shaped.push(tool)
      used.add(name)
      continue
    }

    // 其他非官方工具（如 custom_tool, subagent_fork 等）：统一重命名为 mcp_<hash>
    const wire = clientToolWireName(name, used)
    renames.add(name, wire)
    shaped.push(withName(shape, tool, wire))
    used.add(wire)
  }

  // This lane's gate wants read + shell. Add only what is missing, and mark it
  // as a placeholder so the model does not call a tool the host cannot run.
  const injected = []
  if (!used.has('read')) {
    const read = officialTool(shape, 'read')
    if (read !== undefined && read !== null) {
      shaped.push(read)
      injected.push('read')
      used.add('read')
    }
  }
  if (!used.has('shell')) {
    const shell = officialTool(shape, 'shell')
    if (shell !== undefined && shell !== null) {
      shaped.push(shell)
      injected.push('shell')
      used.add('shell')
    }
  }

  body.tools = shaped
  return { renames, semantics, injected }
}

/**
 * Translate one complete tool-call argument string.
 *
 * Invalid JSON is returned as-is: the host's own validation reports the real
 * problem, and throwing here would turn a model mistake into a stream failure.
 *
 * @param raw - the arguments string.
 * @param inbound - the official -> DSH translator.
 * @returns the translated JSON string, or the original when it cannot translate.
 */
export function translateToolArguments(raw, inbound) {
  if (typeof raw !== 'string' || raw.trim() === '') return raw
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
  try {
    const translated = inbound(parsed)
    return translated !== null && typeof translated === 'object' && !Array.isArray(translated)
      ? JSON.stringify(translated)
      : raw
  } catch {
    return raw
  }
}

/** Rewrite tool_choice so it targets the wire name. */
export function rewriteToolChoice(body, shape, renames) {
  if (!body || typeof body !== 'object' || !body.tool_choice || !(renames instanceof ToolRenameMap)) return
  if (shape === 'chat') {
    const choice = body.tool_choice
    if (choice !== null && typeof choice === 'object' && choice.function) {
      const target = renames.wireOf(choice.function.name)
      if (target !== undefined) choice.function.name = target
    }
  } else if (shape === 'claude') {
    const choice = body.tool_choice
    if (choice !== null && typeof choice === 'object' && typeof choice.name === 'string') {
      const target = renames.wireOf(choice.name)
      if (target !== undefined) choice.name = target
    }
  } else if (shape === 'flat') {
    const choice = body.tool_choice
    if (choice !== null && typeof choice === 'object' && typeof choice.name === 'string') {
      const target = renames.wireOf(choice.name)
      if (target !== undefined) choice.name = target
    }
  }
}
