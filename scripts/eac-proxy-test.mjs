/**
 * The EAC lane's own egress proxy.
 *
 * Two halves, both offline:
 *
 * 1. the wire — `directFetch` against a local target and a local HTTP proxy,
 *    pinning that `auto` keeps the environment order, `direct` really bypasses
 *    it, `url` dials the configured address, and a broken `url` fails the call
 *    instead of silently connecting directly;
 * 2. the settings route — `/settings` accepts exactly the three modes, refuses
 *    an empty or non-http(s) address in `url` mode, and `/summary` echoes what
 *    was saved (the page renders from it).
 *
 * Run: node scripts/eac-proxy-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { callRoute, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'
import { directFetch, lane, proxyAddress } from '../src/eac.js'
import { CODE, UpstreamError } from '../src/http.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const checkThat = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
}

// ── the wire ────────────────────────────────────────────────────────────────
const ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
}
const clearProxyEnv = () => { for (const key of ENV_KEYS) delete process.env[key] }

const savedLane = { fetch: lane.fetch, proxy: lane.proxy, proxyConfig: lane.proxyConfig }
const restoreLane = () => {
  lane.fetch = savedLane.fetch
  lane.proxy = savedLane.proxy
  lane.proxyConfig = savedLane.proxyConfig
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => {
  server.closeAllConnections?.()
  server.close(resolve)
})

const target = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('target')
})
await listen(target)
const targetPort = target.address().port
const proxied = []
const proxy = http.createServer((req, res) => {
  proxied.push(req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('proxied')
})
await listen(proxy)
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

try {
  clearProxyEnv()
  lane.fetch = null
  lane.proxy = undefined
  check('a bare host:port is normalized to an http URL', proxyAddress('127.0.0.1:7890'), 'http://127.0.0.1:7890/')
  check('a SOCKS address is not accepted by this transport', proxyAddress('socks5://127.0.0.1:7890'), null)
  check('an empty address is not accepted', proxyAddress('   '), null)

  // direct: the environment proxy exists but must be ignored.
  process.env.HTTP_PROXY = proxyUrl
  lane.proxyConfig = () => ({ mode: 'direct', url: '' })
  {
    const before = proxied.length
    const response = await directFetch(`http://127.0.0.1:${targetPort}/direct`)
    check('direct mode answers from the target', await response.text(), 'target')
    check('direct mode never touches the proxy', proxied.length - before, 0)
  }

  // url: every hop goes through the configured proxy.
  lane.proxyConfig = () => ({ mode: 'url', url: proxyUrl })
  {
    const before = proxied.length
    const response = await directFetch(`http://127.0.0.1:${targetPort}/through-proxy`)
    check('url mode answers from the proxy', await response.text(), 'proxied')
    check('url mode dials the proxy once', proxied.length - before, 1)
    checkThat('the proxy sees the absolute target URL', proxied.at(-1) === `http://127.0.0.1:${targetPort}/through-proxy`, String(proxied.at(-1)))
  }

  // auto: unchanged behaviour, the environment still supplies the proxy.
  lane.proxyConfig = () => ({ mode: 'auto', url: '' })
  {
    const before = proxied.length
    const response = await directFetch(`http://127.0.0.1:${targetPort}/auto`)
    check('auto mode still uses the environment proxy', await response.text(), 'proxied')
    check('auto mode dials the proxy once', proxied.length - before, 1)
  }

  // A configured-but-broken address must fail the call, never fall through.
  for (const [label, url] of [['an empty address', ''], ['a SOCKS address', 'socks5://127.0.0.1:7890'], ['a malformed address', 'http://']]) {
    lane.proxyConfig = () => ({ mode: 'url', url })
    let caught
    try { await directFetch(`http://127.0.0.1:${targetPort}/broken`) } catch (error) { caught = error }
    checkThat(`url mode refuses ${label}`, caught instanceof UpstreamError && caught.code === CODE.transport, String(caught?.message ?? caught))
  }

  // The test seam still wins over the settings source.
  lane.proxy = proxyUrl
  lane.proxyConfig = () => ({ mode: 'direct' })
  {
    const response = await directFetch(`http://127.0.0.1:${targetPort}/seam`)
    check('the lane.proxy test seam outranks the settings source', await response.text(), 'proxied')
  }
} finally {
  restoreLane()
  restoreEnv()
  await close(proxy)
  await close(target)
}

// ── the settings route ──────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-eac-proxy-'))
const savedHome = process.env.DSH_HOME
const savedBase = process.env.OUR_FREE_MODEL_BASE
const stub = await stubUpstream({ listing: [] })
process.env.DSH_HOME = scratch
process.env.OUR_FREE_MODEL_BASE = stub.base
fs.mkdirSync(path.join(scratch, 'our-free-model'), { recursive: true })
fs.writeFileSync(path.join(scratch, 'our-free-model', 'settings.json'), JSON.stringify({
  version: 1, enabled: true, probeIntervalMinutes: 1440,
  // A hand-written value: the page must render what the file holds.
  eacProxy: { mode: 'direct', url: 'http://127.0.0.1:7890' },
}), { mode: 0o600 })

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
try {
  await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
  const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)
  const get = url => callRoute(api(), 'GET', `/api/our-free-model${url}`)

  check('summary echoes the stored proxy', (await get('/summary')).json?.settings?.eacProxy, { mode: 'direct', url: 'http://127.0.0.1:7890' })

  check('saving a custom address is accepted', (await post('/settings', { eacProxy: { mode: 'url', url: 'http://127.0.0.1:7891' } })).status, 200)
  check('the saved mode and address are echoed', (await get('/summary')).json?.settings?.eacProxy, { mode: 'url', url: 'http://127.0.0.1:7891' })

  check('a bare host:port is accepted in url mode', (await post('/settings', { eacProxy: { mode: 'url', url: '127.0.0.1:7892' } })).status, 200)
  check('an empty address is refused in url mode', (await post('/settings', { eacProxy: { mode: 'url', url: '' } })).status, 400)
  check('a SOCKS address is refused', (await post('/settings', { eacProxy: { mode: 'url', url: 'socks5://127.0.0.1:7892' } })).status, 400)
  check('an unknown mode is refused', (await post('/settings', { eacProxy: { mode: 'sideways' } })).status, 400)

  check('a patch without url keeps the stored address', (await post('/settings', { eacProxy: { mode: 'direct' } })).status, 200)
  check('the stored address survived an omitted url', (await get('/summary')).json?.settings?.eacProxy, { mode: 'direct', url: '127.0.0.1:7892' })
  check('switching to direct keeps the stored address', (await post('/settings', { eacProxy: { mode: 'direct', url: 'http://127.0.0.1:7892' } })).status, 200)
  check('direct is echoed with its address', (await get('/summary')).json?.settings?.eacProxy, { mode: 'direct', url: 'http://127.0.0.1:7892' })
  const stored = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  check('the mode is persisted to settings.json', stored.eacProxy, { mode: 'direct', url: 'http://127.0.0.1:7892' })
} finally {
  for (const disposer of (ctx.__disposers ?? []).reverse()) {
    try { disposer() } catch { /* teardown must not fail the suite */ }
  }
  await stub.close()
  restoreEnv()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedBase === undefined) delete process.env.OUR_FREE_MODEL_BASE
  else process.env.OUR_FREE_MODEL_BASE = savedBase
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0
  ? '\neac-proxy: the lane honours auto/direct/url, a broken address never falls back, and the route validates'
  : `\neac-proxy: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
