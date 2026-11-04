/**
 * The real credential the free lane sends instead of the anonymous key.
 *
 * Upstream fact (2026-11-04, measured through this plugin's own shaping): the
 * 2.2.x free lane no longer accepts the keyless identity. The identical body,
 * headers and session answer `429 FreeUsageLimitError` with `Authorization:
 * Bearer public` and **200** with a Console access token — so everything else
 * the shaper does (canonical session, `<env>`, official tools, Bun transport)
 * was already right, and the credential is the only broken input.
 *
 * The lane has no login of its own (the vendored channel pack's OpenCode
 * account flow is mounted with `disableOpencode`), so a credential must come
 * from outside. Resolution order, first non-empty wins:
 *
 * 1. `OUR_FREE_MODEL_OPENCODE_TOKEN` — an `oc_`/`sk-` key or a Console access
 *    token, for hosts that do not run `dsh-llm-opencode-zen`.
 * 2. `$DSH_HOME/opencode-zen-console.json` → `accessToken` — the file that
 *    plugin already maintains (0600, refreshed five minutes before expiry).
 *    A token inside its last five minutes is treated as expired.
 * 3. `public` — the legacy anonymous key, kept so a host without any of the
 *    above keeps today's behaviour (an honest 429) instead of throwing.
 *
 * The token is never logged: callers may log {@link describeOpencodeCredential}'s
 * `source` label instead.
 *
 * @module src/opencode-credential.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The keyless credential the lane used before 2.2.x closed it (`ANONYMOUS_CREDENTIAL`). */
export const ANONYMOUS_CREDENTIAL = 'public'

/** File name `dsh-llm-opencode-zen` keeps its Console token in. */
export const CONSOLE_TOKEN_FILE = 'opencode-zen-console.json'

/** A token inside this window is treated as expired (matches that plugin's refresh skew). */
export const EARLY_EXPIRY_MS = 5 * 60 * 1000

/** `$DSH_HOME`, falling back to `~/.dsh` exactly like the host does. */
export function dshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

/** Absolute path of the Console token file this module reads. */
export function consoleTokenPath(env = process.env) {
  return path.join(dshHome(env), CONSOLE_TOKEN_FILE)
}

/**
 * Read and vet the Console token file.
 *
 * @returns {{ credential: string, accepted: boolean, reason: 'ok' | 'missing' | 'unreadable' | 'empty' | 'expired' }}
 */
function readConsoleCredential({ path: filePath, readFile, now }) {
  let raw
  try {
    raw = readFile(filePath, 'utf8')
  } catch {
    return { credential: '', accepted: false, reason: 'missing' }
  }
  try {
    const parsed = JSON.parse(String(raw))
    const token = typeof parsed?.accessToken === 'string' ? parsed.accessToken
      : typeof parsed?.access_token === 'string' ? parsed.access_token : ''
    const trimmed = token.trim()
    if (trimmed.length === 0) return { credential: '', accepted: false, reason: 'empty' }
    const expiresAt = Number(parsed?.expiresAt ?? parsed?.expires_at ?? 0)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - EARLY_EXPIRY_MS <= now) {
      return { credential: '', accepted: false, reason: 'expired' }
    }
    return { credential: trimmed, accepted: true, reason: 'ok' }
  } catch {
    return { credential: '', accepted: false, reason: 'unreadable' }
  }
}

/** Resolve the credential plus where it came from, without exposing the token. */
export function inspectOpencodeCredential({ env = process.env, readFile = fs.readFileSync, now = Date.now(), path: filePath } = {}) {
  const fromEnv = typeof env.OUR_FREE_MODEL_OPENCODE_TOKEN === 'string' ? env.OUR_FREE_MODEL_OPENCODE_TOKEN.trim() : ''
  if (fromEnv.length > 0) return { credential: fromEnv, source: 'env', detail: 'ok' }
  const file = readConsoleCredential({ path: filePath ?? consoleTokenPath(env), readFile, now })
  if (file.accepted) return { credential: file.credential, source: 'console-file', detail: 'ok' }
  return { credential: ANONYMOUS_CREDENTIAL, source: 'anonymous', detail: file.reason }
}

/** The credential to send as `Authorization: Bearer …`. */
export function resolveOpencodeCredential(options = {}) {
  return inspectOpencodeCredential(options).credential
}

/**
 * A log-safe description of the credential source: `{ source, detail }`, where
 * source is one of `env` / `console-file` / `anonymous`. Never carries the token.
 */
export function describeOpencodeCredential(options = {}) {
  const { source, detail } = inspectOpencodeCredential(options)
  return { source, detail }
}
