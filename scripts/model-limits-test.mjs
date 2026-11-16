/**
 * Per-model context / output caps, end to end and offline.
 *
 * The free lanes advertise the full catalog window (up to 1M) and the plugin
 * only had one global output ceiling, so a long turn on a roomy model could burn
 * the day's quota before the host ever compacted. A per-model cap fixes that at
 * the two numbers the host actually reads — `contextWindow` and
 * `defaultMaxTokens` — but only if it survives the whole path:
 *
 * 1. the pure store helpers (validation, clamping, read-path filtering);
 * 2. `POST /settings` (accept, refuse atomically, replace-not-merge, persist);
 * 3. the runtime projection (`/summary`, discovery, chain capacities);
 * 4. the adapter (`resolveModel` and the `max_tokens` on the real request).
 *
 * Run: node scripts/model-limits-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, chatFrames, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const MODEL = 'deepseek-v4.1-flash-free'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-limits-'))
const savedHome = process.env.DSH_HOME
const savedBase = process.env.OUR_FREE_MODEL_BASE
/**
 * The gateway stand-in goes up before the plugin modules are imported, because
 * `src/upstream.js` reads `OUR_FREE_MODEL_BASE` once, at import time.
 */
const stub = await stubUpstream({ listing: [MODEL], answer: () => ({ body: chatFrames('hello') }) })
process.env.DSH_HOME = scratch
process.env.OUR_FREE_MODEL_BASE = stub.base
const settingsPath = path.join(scratch, 'our-free-model', 'settings.json')
fs.mkdirSync(path.join(scratch, 'our-free-model'), { recursive: true })
fs.writeFileSync(settingsPath, JSON.stringify({
  version: 1,
  enabled: true,
  probeIntervalMinutes: 1440,
  modelLimits: {
    [MODEL]: { contextWindow: 131072, maxOutput: 8192 },
    // Not in the catalog right now; a cap saved for it must still apply later.
    'no-such-model': { contextWindow: 262144 },
    // A hand-edited value the API would have refused. The read path has to read
    // it as "no cap": 1K of context would leave the host no compaction budget.
    'broken-model': { contextWindow: 1024 },
  },
}, null, 2), { mode: 0o600 })

let ctx
const { apply, inject } = await import('../index.js')
const { ROUTE_MAIN } = await import('../src/adapter.js')
const store = await import('../src/store.js')

try {
  // ── 1. the pure helpers ────────────────────────────────────────────────────
  const entry = { id: MODEL, contextWindow: 1048576, maxOutput: 384000 }
  const capped = store.withModelLimits(entry, { modelLimits: { [MODEL]: { contextWindow: 131072, maxOutput: 8192 } } })
  check('a cap clamps both fields', {
    context: capped.contextWindow, output: capped.maxOutput,
    baseContext: capped.catalogContextWindow, baseOutput: capped.catalogMaxOutput,
  }, { context: 131072, output: 8192, baseContext: 1048576, baseOutput: 384000 })
  check('a row with no cap is returned by identity', store.withModelLimits(entry, {}) === entry, true)
  check('a cap can only lower the catalog value',
    store.withModelLimits(entry, { modelLimits: { [MODEL]: { contextWindow: 4194304 } } }).contextWindow, 1048576)
  check('the per-model output cap replaces the global default',
    store.defaultMaxTokensFor(capped, { defaultMaxTokens: 32768, modelLimits: { [MODEL]: { maxOutput: 8192 } } }), 8192)
  check('without a cap the global default still binds',
    store.defaultMaxTokensFor(entry, { defaultMaxTokens: 32768 }), 32768)
  check('a hand-edited below-floor context is no cap',
    store.modelLimitOf({ modelLimits: { m: { contextWindow: 1024 } } }, 'm'), undefined)
  check('a hand-edited string value is no cap',
    store.modelLimitOf({ modelLimits: { m: { maxOutput: '8192' } } }, 'm'), undefined)
  let rejected
  try { store.validateModelLimits({ modelLimits: { [MODEL]: { contextWindow: 1024 } } }) } catch (error) { rejected = error }
  check('the validator refuses a context below the host floor',
    { status: rejected?.statusCode, kind: rejected?.message?.includes('contextWindow') }, { status: 400, kind: true })

  // ── 2. the settings route and the runtime projection ───────────────────────
  const routes = []
  ctx = fakeContext({
    inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'],
    onRegister: route => routes.push(route),
  })
  apply(ctx, {})
  const api = () => routes.find(route => route.kind === 'prefix')?.handler
  await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
  const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)
  const get = url => callRoute(api(), 'GET', `/api/our-free-model${url}`)

  check('a listing refresh names the model', (await post('/refresh', { probe: false })).status, 200)
  const summary = (await get('/summary')).json
  const rowOf = snapshot => (snapshot.catalog ?? []).find(item => item.id === MODEL)
  check('settings echo the usable caps only',
    Object.keys(summary.settings.modelLimits ?? {}).sort(), [MODEL, 'no-such-model'].sort())
  check('a hand-edited below-floor entry is dropped from the echo',
    Object.hasOwn(summary.settings.modelLimits ?? {}, 'broken-model'), false)
  check('the row advertises the capped window',
    { context: rowOf(summary)?.contextWindow, output: rowOf(summary)?.maxOutput }, { context: 131072, output: 8192 })
  check('the row keeps the catalog capacity for the editor',
    { context: rowOf(summary)?.catalogContextWindow, output: rowOf(summary)?.catalogMaxOutput },
    { context: 1048576, output: 384000 })
  check('the stored cap rides the row', rowOf(summary)?.limits, { contextWindow: 131072, maxOutput: 8192 })

  const discovered = (await ctx.__captured.discovery()) ?? []
  const discoveredRow = discovered.find(item => item.id === MODEL)
  check('discovery advertises the capped window',
    { context: discoveredRow?.contextWindow, max: discoveredRow?.maxTokens }, { context: 131072, max: 8192 })

  // ── 3. the adapter reads the projection ────────────────────────────────────
  const adapter = ctx.__captured.adapters.find(item => item.routes.includes(ROUTE_MAIN))?.adapter
  const resolved = await adapter.resolveModel(ROUTE_MAIN, MODEL)
  check('resolveModel reports the capped window', resolved.context, { contextWindow: 131072 })
  check('resolveModel reports the per-model output ceiling', resolved.defaultMaxTokens, 8192)
  const unknown = await adapter.resolveModel(ROUTE_MAIN, 'no-such-model')
  check('a capped id outside the catalog still resolves at the cap',
    { context: unknown.context.contextWindow, max: unknown.defaultMaxTokens }, { context: 262144, max: 8192 })
  const broken = await adapter.resolveModel(ROUTE_MAIN, 'broken-model')
  check('a hand-edited below-floor value resolves as uncapped',
    { context: broken.context.contextWindow, max: broken.defaultMaxTokens }, { context: 131072, max: 8192 })

  const sent = async options => {
    const before = stub.requests.length
    for await (const chunk of adapter.stream({
      provider: ROUTE_MAIN, model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...options,
    })) void chunk
    return stub.requests[before].body
  }
  check('the capped model puts its ceiling on the wire', (await sent({})).max_tokens, 8192)
  check('a caller asking for more is still capped', (await sent({ maxTokens: 30000 })).max_tokens, 8192)

  // ── 4. writes: replace, validate atomically, clear ─────────────────────────
  check('a cap above the catalog is accepted', (await post('/settings', {
    modelLimits: { [MODEL]: { contextWindow: 4194304 } },
  })).status, 200)
  const raised = (await get('/summary')).json
  check('but the advertised window stays the catalog value', rowOf(raised)?.contextWindow, 1048576)
  check('the cap is stored as entered', raised.settings.modelLimits, { [MODEL]: { contextWindow: 4194304 } })

  const beforeInvalid = fs.readFileSync(settingsPath, 'utf8')
  for (const [label, patch] of [
    ['a non-object map', { modelLimits: 'nope' }],
    ['an array', { modelLimits: [] }],
    ['an empty model id', { modelLimits: { '': { maxOutput: 1024 } } }],
    ['a fractional output', { modelLimits: { [MODEL]: { maxOutput: 1.5 } } }],
    ['a context below the host floor', { modelLimits: { [MODEL]: { contextWindow: 1024 } } }],
    ['an unknown field', { modelLimits: { [MODEL]: { bogus: 1 } } }],
    ['a null entry', { modelLimits: { [MODEL]: null } }],
    ['an output above the bound', { modelLimits: { [MODEL]: { maxOutput: 9999999 } } }],
    // Any headroom policy leaves no message budget when the window equals the
    // output reserve; the host throws before a turn can start.
    ['a window equal to the output reserve', { modelLimits: { [MODEL]: { contextWindow: 131072, maxOutput: 384000 } } }],
  ]) {
    check(`${label} is refused`, (await post('/settings', patch)).status, 400)
  }
  check('a refused patch leaves the file untouched', fs.readFileSync(settingsPath, 'utf8'), beforeInvalid)

  check('the map is replaced, not merged', (await post('/settings', {
    modelLimits: { [MODEL]: { maxOutput: 4096 } },
  })).status, 200)
  const replaced = (await get('/summary')).json
  check('the replacement is exactly what was sent', replaced.settings.modelLimits, { [MODEL]: { maxOutput: 4096 } })
  check('the window follows the catalog again', rowOf(replaced)?.contextWindow, 1048576)
  check('the output follows the new cap', rowOf(replaced)?.maxOutput, 4096)
  check('the quieter cap reaches the wire', (await sent({})).max_tokens, 4096)

  check('clearing the map is accepted', (await post('/settings', { modelLimits: {} })).status, 200)
  const cleared = (await get('/summary')).json
  check('the row returns to the catalog capacity',
    { context: rowOf(cleared)?.contextWindow, output: rowOf(cleared)?.maxOutput },
    { context: 1048576, output: 384000 })
  check('the stored cap is gone', rowOf(cleared)?.limits ?? null, null)
  check('settings echo the empty map', cleared.settings.modelLimits, {})
  check('and the adapter follows the global default again',
    (await adapter.resolveModel(ROUTE_MAIN, MODEL)).defaultMaxTokens, 32768)
  check('the wire follows too', (await sent({})).max_tokens, 32768)
} finally {
  for (const disposer of (ctx.__disposers ?? []).reverse()) {
    try { disposer() } catch { /* teardown must not fail the suite */ }
  }
  await stub.close()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedBase === undefined) delete process.env.OUR_FREE_MODEL_BASE
  else process.env.OUR_FREE_MODEL_BASE = savedBase
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0
  ? '\nmodel-limits: caps are validated, projected, advertised and sent'
  : `\nmodel-limits: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
