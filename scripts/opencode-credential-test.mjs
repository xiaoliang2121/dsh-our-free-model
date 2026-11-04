/**
 * Tests for the free lane's credential resolver (src/opencode-credential.js).
 *
 * The lane shipped with only `Authorization: Bearer public`, which the 2.2.x
 * gateway answers with 429 FreeUsageLimitError. The resolver feeds a real
 * credential from the environment or from the Console token file that
 * `dsh-llm-opencode-zen` maintains; these tests lock the precedence, the
 * expiry rule, the token-never-logged property, and the wiring that the
 * bundled shaping actually consumes it.
 *
 * Run: node scripts/opencode-credential-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ANONYMOUS_CREDENTIAL,
  EARLY_EXPIRY_MS,
  consoleTokenPath,
  describeOpencodeCredential,
  inspectOpencodeCredential,
  resolveOpencodeCredential,
} from '../src/opencode-credential.js'
import { gatewayHeaders } from '../src/o2a/headers.js'
import { findBunExecutable } from '../src/bun-fetch.js'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error?.message ?? error}`)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credential-test-'))
const tokenFile = path.join(dir, 'opencode-zen-console.json')
const writeToken = (payload) => fs.writeFileSync(tokenFile, JSON.stringify(payload))
const now = 1_800_000_000_000

check('环境变量优先于令牌文件', () => {
  writeToken({ accessToken: 'st_from_file', expiresAt: now + 3_600_000 })
  const resolved = resolveOpencodeCredential({ env: { OUR_FREE_MODEL_OPENCODE_TOKEN: 'sk_from_env' }, path: tokenFile, now })
  assert.equal(resolved, 'sk_from_env')
  assert.deepEqual(describeOpencodeCredential({ env: { OUR_FREE_MODEL_OPENCODE_TOKEN: 'sk_from_env' }, path: tokenFile, now }), { source: 'env', detail: 'ok' })
})

check('无环境变量时读令牌文件的 accessToken', () => {
  writeToken({ accessToken: 'st_from_file', expiresAt: now + 3_600_000 })
  assert.equal(resolveOpencodeCredential({ env: {}, path: tokenFile, now }), 'st_from_file')
  assert.equal(describeOpencodeCredential({ env: {}, path: tokenFile, now }).source, 'console-file')
})

check('临近过期（提前五分钟内）视为过期并回退 public', () => {
  writeToken({ accessToken: 'st_almost_expired', expiresAt: now + EARLY_EXPIRY_MS - 1000 })
  assert.equal(resolveOpencodeCredential({ env: {}, path: tokenFile, now }), ANONYMOUS_CREDENTIAL)
  assert.deepEqual(describeOpencodeCredential({ env: {}, path: tokenFile, now }), { source: 'anonymous', detail: 'expired' })
})

check('文件缺失、坏 JSON、空令牌都回退 public 且不抛错', () => {
  const missing = path.join(dir, 'nope.json')
  assert.equal(resolveOpencodeCredential({ env: {}, path: missing, now }), ANONYMOUS_CREDENTIAL)
  assert.equal(describeOpencodeCredential({ env: {}, path: missing, now }).detail, 'missing')

  fs.writeFileSync(tokenFile, '{not json')
  assert.equal(resolveOpencodeCredential({ env: {}, path: tokenFile, now }), ANONYMOUS_CREDENTIAL)
  assert.equal(describeOpencodeCredential({ env: {}, path: tokenFile, now }).detail, 'unreadable')

  writeToken({ accessToken: '   ' })
  assert.equal(resolveOpencodeCredential({ env: {}, path: tokenFile, now }), ANONYMOUS_CREDENTIAL)
  assert.equal(describeOpencodeCredential({ env: {}, path: tokenFile, now }).detail, 'empty')
})

check('没有 expiresAt 的令牌按可用处理', () => {
  writeToken({ accessToken: 'st_no_expiry' })
  assert.equal(resolveOpencodeCredential({ env: {}, path: tokenFile, now }), 'st_no_expiry')
})

check('$DSH_HOME 决定令牌文件位置，缺省为 ~/.dsh', () => {
  assert.equal(consoleTokenPath({ DSH_HOME: '/tmp/dsh-home' }), path.join('/tmp/dsh-home', 'opencode-zen-console.json'))
  assert.equal(consoleTokenPath({}), path.join(os.homedir(), '.dsh', 'opencode-zen-console.json'))
})

check('描述信息绝不包含令牌本身', () => {
  writeToken({ accessToken: 'st_secret_value_must_not_leak', expiresAt: now + 3_600_000 })
  const described = JSON.stringify(describeOpencodeCredential({ env: {}, path: tokenFile, now }))
  assert.ok(!described.includes('st_secret_value_must_not_leak'))
})

check('gatewayHeaders 使用注入的凭据，缺省仍是 public', () => {
  const withCredential = gatewayHeaders({ session: 'ses_00000000000fAaaaaaaaaaaaaa', credential: 'st_injected' })
  assert.equal(withCredential.authorization, 'Bearer st_injected')
  assert.equal(withCredential['x-opencode-client'], 'cli')
  const fallback = gatewayHeaders({ session: 'ses_00000000000fAaaaaaaaaaaaaa' })
  assert.equal(fallback.authorization, `Bearer ${ANONYMOUS_CREDENTIAL}`)
})

check('Bun 发现不依赖 PATH（绝对路径兜底）', () => {
  const saved = process.env.PATH
  try {
    process.env.PATH = ''
    const found = findBunExecutable()
    const installedAbsent = !['/usr/bin/bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun'].some((candidate) => fs.existsSync(candidate))
    if (installedAbsent) assert.equal(found, undefined)
    else assert.ok(typeof found === 'string' && found.endsWith('bun'), `expected an absolute Bun, got ${found}`)
  } finally {
    process.env.PATH = saved
  }
})

check('运行时产物与接线的凭据支持未过期', () => {
  const bundle = fs.readFileSync(new URL('../src/o2a.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('credential ?? ANONYMOUS_CREDENTIAL'), 'src/o2a.js 未包含凭据参数（需要重建 build-legacy-payload）')
  const http = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8')
  assert.match(http, /credential: resolveOpencodeCredential\(\)/, 'src/http.js 未注入解析结果')
})

fs.rmSync(dir, { recursive: true, force: true })
if (failures > 0) { console.error(`\nopencode-credential-test: ${failures} 项失败`); process.exit(1) }
console.log('\nopencode-credential-test: 全部通过')
