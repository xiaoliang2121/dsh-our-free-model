/**
 * Free-lane tool vocabulary for dsh-llm-our-free-model.
 *
 * The lane's gate wants `read` + `shell`; the model should see the official
 * OpenCode 2.2.x declarations for the tools this host can actually run. This
 * module shapes the outbound `tools` array and translates the inbound call
 * arguments back to DSH. It is deliberately outside `src/o2a/`: SYNC.md keeps
 * that directory a pure port of opencode2api with no plugin-specific tables.
 *
 * Boundaries (conservative on purpose):
 *
 * - tools with a real DSH counterpart become the official name + description +
 *   schema; name-changing maps also enter ToolRenameMap so the response side
 *   restores the DSH spelling;
 * - `bash` maps to the official `shell` (this lane's gate wants shell);
 * - `subagent`, `read_image` and every other DSH-only tool keep their own
 *   schema under the existing opaque `clint_<digest>` wire name;
 * - `patch` / `execute` are never declared;
 * - gate-only declarations (when the host has no read/bash) are the only ones
 *   that keep the placeholder note, so the model does not call a tool the host
 *   cannot execute.
 *
 * @module src/tool-semantics
 */

import {
  CLIENT_TOOL_PREFIX,
  ToolRenameMap,
  clientToolWireName,
  officialTool,
  renamableToolName,
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

const TODOWRITE_DESCRIPTION = [
  'Create and update a todo list for the current session. The user sees it as your working plan.',
  '',
  'Use it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it.',
  '',
  '- Send the full list on every call; it replaces the previous one.',
  '- Mark items `in_progress` when you start them and `completed` as soon as they\'re actually done.',
  '- Only call it when the list changes.',
].join('\n')

const TODOWRITE_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The updated todo list',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Brief description of the task' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'Current status of the task: pending, in_progress, completed, cancelled',
          },
        },
        required: ['content', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
}

/**
 * Render one official declaration in the requested wire shape.
 *
 * `todowrite` is not in the captured 13-tool asset (the capture predates it),
 * so its definition lives here; every other name comes from the ported asset.
 */
function renderOfficial(shape, name) {
  if (name === 'todowrite') {
    const parameters = structuredClone(TODOWRITE_SCHEMA)
    if (shape === 'chat') {
      return { type: 'function', function: { name, description: TODOWRITE_DESCRIPTION, parameters, strict: false } }
    }
    if (shape === 'flat') {
      return { type: 'function', name, description: TODOWRITE_DESCRIPTION, parameters }
    }
    return { name, description: TODOWRITE_DESCRIPTION, input_schema: parameters }
  }
  return officialTool(shape, name)
}

/** Does this declaration already carry the official definition for `name`? */
function isOfficialDefinition(entry, name, shape) {
  const rendered = renderOfficial(shape, name)
  if (rendered === undefined || rendered === null) return false
  const own = shape === 'chat' ? entry?.function : entry
  const official = shape === 'chat' ? rendered.function : rendered
  if (own === null || own === undefined || official === null || official === undefined) return false
  const ownSchema = shape === 'claude' ? own.input_schema : own.parameters
  const officialSchema = shape === 'claude' ? official.input_schema : official.parameters
  return own.description === official.description
    && JSON.stringify(ownSchema) === JSON.stringify(officialSchema)
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
    // The model imitates the DSH spelling it saw in earlier calls (history is
    // not rewritten), so accept both spellings instead of dropping the path.
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
    // A host-shaped call already carries the string array; keep it as-is.
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
        // A host-shaped question (it already has an id or the DSH spelling of
        // multi-select) is kept as-is; translating it again would erase those.
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
    // Official 0 means "no timeout"; DSH requires a positive value. A
    // host-shaped call already carries milliseconds and is taken verbatim.
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
      // A different target already owned by another declaration: keep this
      // tool executable under its opaque name instead of creating a duplicate.
      if (officialName !== name && used.has(officialName)) {
        const wire = renames.wireOf(name) ?? clientToolWireName(name, used)
        renames.add(name, wire)
        shaped.push(withName(shape, tool, wire))
        used.add(wire)
        continue
      }
      const rendered = renderOfficial(shape, officialName)
      if (rendered === undefined || rendered === null) {
        const wire = renames.wireOf(name) ?? clientToolWireName(name, used)
        renames.add(name, wire)
        shaped.push(withName(shape, tool, wire))
        used.add(wire)
        continue
      }
      shaped.push(rendered)
      if (officialName !== name) renames.add(name, officialName)
      semantics.set(name, INBOUND[officialName])
      used.add(officialName)
      continue
    }
    if (name.startsWith(CLIENT_TOOL_PREFIX)) {
      shaped.push(tool)
      used.add(name)
      continue
    }
    const dsh = DSH_BY_OFFICIAL[name]
    if (dsh !== undefined && isOfficialDefinition(tool, name, shape)) {
      // Idempotence: a body that was already shaped must not be renamed again.
      shaped.push(tool)
      if (dsh === name) semantics.set(name, INBOUND[name])
      used.add(name)
      continue
    }
    const wire = renames.wireOf(name) ?? clientToolWireName(name, used)
    renames.add(name, wire)
    shaped.push(withName(shape, tool, wire))
    used.add(wire)
  }

  // This lane's gate wants read + shell. Add only what is missing, and mark it
  // as a placeholder so the model does not call a tool the host cannot run.
  const injected = []
  if (!used.has('read')) {
    const read = renderOfficial(shape, 'read')
    if (read !== undefined && read !== null) {
      shaped.push(read)
      injected.push('read')
      used.add('read')
    }
  }
  if (!used.has('shell')) {
    const shell = renderOfficial(shape, 'shell')
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

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Rewrite a tool_choice that names a renamed tool; history is intentionally left alone. */
export function rewriteToolChoice(body, shape, renames) {
  if (renames.size === 0) return
  const choice = objectOf(body.tool_choice)
  if (choice === null) return
  const renamed = (container) => {
    if (container === null || typeof container !== 'object') return null
    const name = container.name
    if (typeof name !== 'string') return null
    const wire = renames.wireOf(name)
    return wire !== undefined && wire !== name ? wire : null
  }
  if (shape === 'chat') {
    if (choice.function && typeof choice.function === 'object') {
      const wire = renamed(choice.function)
      if (wire !== null) body.tool_choice = { ...choice, function: { ...choice.function, name: wire } }
      return
    }
    const wire = renamed(choice)
    if (wire !== null) body.tool_choice = { ...choice, name: wire }
    return
  }
  const wire = renamed(choice)
  if (wire !== null) body.tool_choice = { ...choice, name: wire }
}
