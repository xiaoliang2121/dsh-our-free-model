/**
 * The per-model cap editor, without a browser.
 *
 * The editor is the only place a user can lower a model's window, and it sits
 * inside the roster card, so the checks are about the wiring rather than the
 * pixels: both fields carry the stored cap (and the catalog value as the
 * placeholder), the numeric guard names the field it refuses, and the card only
 * offers the editor when the page can actually save (`onApply` exists).
 *
 * Run: node scripts/model-limits-ui-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let record
const react = {
  createElement: (type, props, ...children) => ({
    type, props: { ...props, ...children.length ? { children: children.length === 1 ? children[0] : children } : {} }, children,
  }),
  Fragment: 'fragment',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useRef: () => ({ current: null }),
}
new Function('window', 'document', 'navigator', source)(
  { __ModuleLoader__: { load: value => { record = value } } },
  { createElement: () => ({ setAttribute() {}, style: {}, remove() {} }), head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
  { language: 'zh-CN' })
const { LimitEditor, ModelCard, limitPatchOf, DICT } = record.factory(name => {
  if (name === 'react') return react
  if (name === 'react-dom') return { createPortal: (children, container) => ({ type: 'portal', children, container }) }
  throw new Error(`the browser half may only require react or react-dom; it asked for "${name}"`)
}).__test

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function flatten(value, out = []) {
  if (Array.isArray(value)) { for (const child of value) flatten(child, out); return out }
  if (value === null || value === undefined || typeof value === 'boolean') return out
  if (typeof value === 'object') {
    out.push(value)
    // The stub React does not execute function components, so the walk does it.
    flatten(typeof value.type === 'function' ? value.type(value.props) : value.children, out)
  } else out.push(value)
  return out
}
const nodes = tree => flatten(tree)
const text = tree => nodes(tree).filter(node => typeof node === 'string').join(' ')
const inputs = tree => nodes(tree).filter(node => typeof node === 'object' && node.type === 'input')
const buttons = tree => nodes(tree).filter(node => typeof node === 'object' && String(node.props?.className ?? '').split(/\s+/).includes('ofm_btn'))

const zh = Object.assign(key => DICT.zh[key] ?? key, { locale: 'zh-CN' })
const MODEL = {
  id: 'deepseek-v4.1-flash-free',
  name: 'DeepSeek V4.1 Flash',
  channel: 'anonymous',
  route: 'our-free-model',
  availability: 'available',
  availabilitySource: 'probe',
  contextWindow: 131072,
  maxOutput: 8192,
  catalogContextWindow: 1048576,
  catalogMaxOutput: 384000,
  limits: { contextWindow: 131072, maxOutput: 8192 },
  budgets: [],
  probedAt: Date.now() - 60_000,
}

check('both dictionaries carry every editor key', () => {
  for (const locale of ['zh', 'en']) {
    for (const key of ['limits.edit', 'limits.close', 'limits.context', 'limits.output', 'limits.save',
      'limits.reset', 'limits.custom', 'limits.customTitle', 'limits.hint', 'limits.invalidContext', 'limits.invalidOutput']) {
      assert.ok(typeof DICT[locale][key] === 'string' && DICT[locale][key] !== '', `${locale} ${key}`)
    }
  }
})

check('a filled editor turns into the exact patch', () => {
  assert.deepEqual(limitPatchOf({ contextWindow: ' 262144 ', maxOutput: '4096' }, MODEL),
    { patch: { contextWindow: 262144, maxOutput: 4096 } })
  assert.deepEqual(limitPatchOf({ contextWindow: '131072', maxOutput: '' }, MODEL),
    { patch: { contextWindow: 131072 } })
  assert.deepEqual(limitPatchOf({ contextWindow: '', maxOutput: '4096' }, MODEL),
    { patch: { maxOutput: 4096 } })
})

check('two empty fields mean "no cap", not zero', () => {
  assert.deepEqual(limitPatchOf({ contextWindow: '', maxOutput: '' }, MODEL), { patch: {} })
})

check('the numeric guard names the field it refuses', () => {
  for (const draft of [
    { contextWindow: '131071' }, // below the host floor
    { contextWindow: 'abc' },
    { contextWindow: '1048577' }, // above the catalog
    { contextWindow: '1.5' },
  ]) assert.deepEqual(limitPatchOf(draft, MODEL), { error: 'context' }, JSON.stringify(draft))
  for (const draft of [
    { maxOutput: '0' },
    { maxOutput: 'abc' },
    { maxOutput: '384001' },
    { maxOutput: '1.5' },
  ]) assert.deepEqual(limitPatchOf(draft, MODEL), { error: 'output' }, JSON.stringify(draft))
})

check('the editor shows the stored cap and the catalog value as the placeholder', () => {
  const tree = LimitEditor({ t: zh, model: MODEL, draft: { contextWindow: '262144', maxOutput: '4096' }, error: '', busy: false, onChange: () => {}, onSave: () => {}, onReset: () => {} })
  const fields = inputs(tree)
  assert.equal(fields.length, 2)
  assert.equal(fields[0].props.value, '262144')
  assert.equal(fields[1].props.value, '4096')
  assert.equal(fields[0].props.placeholder, '1048576')
  assert.equal(fields[1].props.placeholder, '384000')
  assert.equal(fields[0].props.inputMode, 'numeric')
})

check('typing reaches the draft, not the store', () => {
  const calls = []
  const tree = LimitEditor({
    t: zh, model: MODEL, draft: { contextWindow: '', maxOutput: '' }, error: '', busy: false,
    onChange: (field, value) => calls.push([field, value]), onSave: () => calls.push('save'), onReset: () => calls.push('reset'),
  })
  inputs(tree)[0].props.onChange({ target: { value: '524288' } })
  inputs(tree)[1].props.onChange({ target: { value: '2048' } })
  assert.deepEqual(calls, [['contextWindow', '524288'], ['maxOutput', '2048']])
  const actions = buttons(tree)
  assert.equal(actions.length, 2)
  actions[0].props.onClick()
  actions[1].props.onClick()
  assert.deepEqual(calls.slice(-2), ['save', 'reset'])
})

check('an error replaces the hint and blocks the buttons', () => {
  const tree = LimitEditor({
    t: zh, model: MODEL, draft: { contextWindow: '', maxOutput: '' }, error: DICT.zh['limits.invalidContext'], busy: true,
    onChange: () => {}, onSave: () => {}, onReset: () => {},
  })
  assert.equal(nodes(tree).filter(node => typeof node === 'object' && String(node.props?.className ?? '').includes('ofm_error_note')).length, 1)
  assert.ok(text(tree).includes(DICT.zh['limits.invalidContext']))
  assert.equal(text(tree).includes(DICT.zh['limits.hint']), false)
  assert.ok(buttons(tree).every(node => node.props.disabled === true))
})

check('the card offers the editor only when the page can save', () => {
  const capped = ModelCard({ t: zh, model: MODEL, onLimits: () => {}, busy: false })
  const toggle = buttons(capped).find(node => text(node).includes(DICT.zh['limits.edit']))
  assert.ok(toggle !== undefined, 'a toggle is rendered')
  assert.equal(toggle.props['aria-expanded'], 'false')
  assert.equal(text(capped).includes(DICT.zh['limits.custom']), true, 'a capped model says so')
  assert.equal(nodes(capped).filter(node => typeof node === 'object' && node.props?.className === 'ofm_limitform').length, 0, 'closed by default')

  const plain = ModelCard({ t: zh, model: { ...MODEL, limits: null }, busy: false })
  assert.equal(buttons(plain).some(node => text(node).includes(DICT.zh['limits.edit'])), false)
  assert.equal(text(plain).includes(DICT.zh['limits.custom']), false)
})

check('the card advertises the effective numbers, not the catalog ones', () => {
  const capped = ModelCard({ t: zh, model: MODEL, onLimits: () => {}, busy: false })
  const page = text(capped)
  assert.ok(page.includes('131K'), `context tag: ${page}`)
  assert.ok(page.includes('8.2K'), `output tag: ${page}`)
  assert.equal(page.includes('1.0M'), false)
})

console.log(failures === 0 ? '\nmodel-limits-ui: the editor edits and the card offers it' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
