/**
 * The free lane's configurable client identity (v2 User-Agent).
 *
 * Two halves, both offline:
 *
 * 1. the settings route — `/settings` accepts `clientChannel` / `clientVersion`,
 *    /summary echoes them, an invalid value is refused atomically, and an empty
 *    value means "follow the built-in CLIENT_UA";
 * 2. the wire — the saved identity reaches the actual request, and does so on
 *    both exits (the listing GET and the inference POST share one resolver).
 *
 * Run: node scripts/client-ua-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-client-ua-'))
const savedHome = process.env.DSH_HOME
const savedBase = process.env.OUR_FREE_MODEL_BASE
const stub = await stubUpstream({ listing: [] })
process.env.DSH_HOME = scratch
process.env.OUR_FREE_MODEL_BASE = stub.base
fs.mkdirSync(path.join(scratch, 'our-free-model'), { recursive: true })
fs.writeFileSync(path.join(scratch, 'our-free-model', 'settings.json'), JSON.stringify({
  version: 1,
  enabled: true,
  probeIntervalMinutes: 1440,
  // A hand-written identity: the page must render what the file holds.
  clientChannel: 'beta',
  clientVersion: '2.4.0',
}), { mode: 0o600 })

const { apply, inject } = await import('../index.js')
const { postStreamed, resolveClientUserAgent } = await import('../src/http.js')
const up = await import('../src/upstream.js')

const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler

try {
  await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
  const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)
  const get = url => callRoute(api(), 'GET', `/api/our-free-model${url}`)

  check('summary echoes the stored identity', {
    channel: (await get('/summary')).json?.settings?.clientChannel,
    version: (await get('/summary')).json?.settings?.clientVersion,
  }, { channel: 'beta', version: '2.4.0' })

  check('saving a custom identity is accepted', (await post('/settings', { clientChannel: 'canary', clientVersion: '2.5.0' })).status, 200)
  check('the saved identity is echoed', {
    channel: (await get('/summary')).json?.settings?.clientChannel,
    version: (await get('/summary')).json?.settings?.clientVersion,
  }, { channel: 'canary', version: '2.5.0' })
  const stored = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  check('the identity is persisted to settings.json', { channel: stored.clientChannel, version: stored.clientVersion }, { channel: 'canary', version: '2.5.0' })

  // Every invalid shape is refused before the store is touched.
  for (const [label, patch] of [
    ['a channel with a space', { clientChannel: 'bad value' }],
    ['a channel with a slash', { clientChannel: 'bad/value' }],
    ['an over-long channel', { clientChannel: 'x'.repeat(33) }],
    ['a two-part version', { clientVersion: '2.5' }],
    ['a 1.x version', { clientVersion: '1.9.0' }],
    ['a non-string channel', { clientChannel: 42 }],
  ]) {
    check(`${label} is refused`, (await post('/settings', patch)).status, 400)
  }
  const afterInvalid = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  check('a refused patch does not change the file', {
    channel: afterInvalid.clientChannel,
    version: afterInvalid.clientVersion,
  }, { channel: 'canary', version: '2.5.0' })

  // The saved identity reaches the wire through the same resolver both exits use.
  await postStreamed({
    path: up.endpointFor('cat-jam-free'),
    body: { model: 'cat-jam-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('ua:test'),
    onData: () => {},
    timeoutMs: 5000,
  })
  check('the saved identity reaches the request', stub.requests.at(-1)?.headers?.['user-agent'], 'opencode/canary/2.5.0/cli')

  // Empty means "follow the built-in"; the built-in is never frozen into the file.
  check('clearing both segments is accepted', (await post('/settings', { clientChannel: '', clientVersion: '' })).status, 200)
  const cleared = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  check('empty is stored as empty', { channel: cleared.clientChannel, version: cleared.clientVersion }, { channel: '', version: '' })
  await postStreamed({
    path: up.endpointFor('cat-jam-free'),
    body: { model: 'cat-jam-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('ua:test-default'),
    onData: () => {},
    timeoutMs: 5000,
  })
  check('empty follows the built-in UA', stub.requests.at(-1)?.headers?.['user-agent'], up.CLIENT_UA)

  check('a partial override keeps the built-in segment', resolveClientUserAgent({ channel: 'beta', version: '' }), 'opencode/beta/2.2.5/cli')
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
  ? '\nclient-ua: the saved channel/version reaches both exits, invalid values are refused atomically'
  : `\nclient-ua: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
