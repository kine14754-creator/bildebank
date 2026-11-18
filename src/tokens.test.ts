import { beforeEach, describe, expect, it } from 'vitest'
import worker from './index'
import { getOAuthRoles, MAX_FAILED_PER_IP } from './oauth'
import { makeEnv } from '../test/helpers'
import type { Env } from './types'

const BASE = 'https://bildebank.test'
const ctxStub = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
const REDIRECT = 'http://localhost:4567/callback'
const VERIFIER = 'test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz'

let env: Env
beforeEach(() => {
  env = makeEnv()
})

const send = (req: Request) => worker.fetch(req, env, ctxStub)

// ── Admin API ───────────────────────────────────────────────────────────────

function admin(method: string, path = '', body?: unknown, secret: string | null = 'correct-key') {
  return send(
    new Request(`${BASE}/admin/mcp-tokens${path}`, {
      method,
      headers: {
        ...(secret !== null ? { Authorization: `Bearer ${secret}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  )
}

async function createToken(name: string, access?: 'read' | 'write'): Promise<string> {
  const res = await admin('POST', '', { name, ...(access ? { access } : {}) })
  expect(res.status).toBe(201)
  return ((await res.json()) as { token: string }).token
}

type Listed = { tokens: { name: string; createdAt: string; access: string }[] }

// ── OAuth flow ──────────────────────────────────────────────────────────────

async function challenge(): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function registerClient(): Promise<string> {
  const reg = await send(
    new Request(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'Claude Code',
      }),
    })
  )
  expect(reg.status).toBe(201)
  return ((await reg.json()) as { client_id: string }).client_id
}

async function authorizeUrl(clientId: string): Promise<string> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'bildebank',
    state: 's',
    code_challenge: await challenge(),
    code_challenge_method: 'S256',
  })
  return `${BASE}/authorize?${q}`
}

const formState = async (res: Response) => ({
  html: await res.text(),
  cookie: res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; '),
})
const handleOf = (html: string) => /name="handle" value="([^"]+)"/.exec(html)![1]!

/** Open the sign-in page and return a function that submits a token on it. */
async function openSignIn(clientId: string, ip = '1.2.3.4') {
  const url = await authorizeUrl(clientId)
  let state = await formState(await send(new Request(url)))
  const page = state.html
  const submit = async (key: string) => {
    const res = await send(
      new Request(url, {
        method: 'POST',
        headers: {
          Cookie: state.cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          'CF-Connecting-IP': ip,
        },
        body: new URLSearchParams({ handle: handleOf(state.html), key }),
      })
    )
    // A failed attempt re-renders the page with a fresh handle + cookie.
    if (res.status !== 302) state = await formState(res.clone())
    return res
  }
  return { page, submit }
}

async function exchangeCode(clientId: string, code: string): Promise<string> {
  const res = await send(
    new Request(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      }),
    })
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { access_token: string }).access_token
}

/** Full sign-in with a personal access token; returns the OAuth access token. */
async function signIn(token: string): Promise<string> {
  const clientId = await registerClient()
  const { submit } = await openSignIn(clientId)
  const res = await submit(token)
  expect(res.status).toBe(302)
  const code = new URL(res.headers.get('Location')!).searchParams.get('code')!
  return exchangeCode(clientId, code)
}

// ── MCP calls ───────────────────────────────────────────────────────────────

function rpc(accessToken: string, body: unknown) {
  return send(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify(body),
    })
  )
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text()
  const json = text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)![1]!
  return JSON.parse(json) as T
}

const initialize = (accessToken: string) =>
  rpc(accessToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })

async function toolNames(accessToken: string): Promise<string[]> {
  const res = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  expect(res.status).toBe(200)
  const body = await parse<{ result: { tools: { name: string }[] } }>(res)
  return body.result.tools.map((t) => t.name).sort()
}

/**
 * Call upload_image with a plain-http URL: a write token reaches the tool and
 * gets the URL-validation error (before any database or network access); a
 * read token never reaches it.
 */
async function callUpload(accessToken: string) {
  const res = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'upload_image', arguments: { sourceUrl: 'http://example.com/a.jpg' } },
  })
  expect(res.status).toBe(200)
  const body = await parse<{
    result?: { isError?: boolean; content: { text: string }[] }
    error?: { message: string }
  }>(res)
  return body.error?.message ?? body.result!.content.map((c) => c.text).join('\n')
}

const READ_TOOLS = ['get_image', 'list_folders', 'search_images', 'view_image']

// ── Tests ───────────────────────────────────────────────────────────────────

describe('admin routes', () => {
  it('reject requests without the API secret, or with a wrong one', async () => {
    for (const secret of [null, 'wrong']) {
      expect((await admin('GET', '', undefined, secret)).status).toBe(401)
      expect((await admin('POST', '', { name: 'Kari' }, secret)).status).toBe(401)
      expect((await admin('PATCH', '/Kari', { access: 'write' }, secret)).status).toBe(401)
      expect((await admin('DELETE', '/Kari', undefined, secret)).status).toBe(401)
    }
    const list = (await (await admin('GET')).json()) as Listed
    expect(list.tokens).toEqual([])
  })

  it('create returns the raw token once and stores only its hash', async () => {
    const res = await admin('POST', '', { name: 'Kari Nordmann' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { name: string; createdAt: string; access: string; token: string }
    expect(body).toMatchObject({ name: 'Kari Nordmann', access: 'read' })
    expect(body.token).toMatch(/^bb_pat_[A-Za-z0-9_-]{43}$/)

    const stored = await env.OAUTH_KV!.list({ prefix: '' })
    const values = await Promise.all(stored.keys.map((k) => env.OAUTH_KV!.get(k.name)))
    expect(values.join('\n')).not.toContain(body.token)
    expect(stored.keys.map((k) => k.name).join('\n')).not.toContain(body.token)
  })

  it('lists name, createdAt and access with no token material', async () => {
    await createToken('Ola')
    await createToken('Kari', 'write')
    const res = await admin('GET')
    expect(res.status).toBe(200)
    const list = (await res.json()) as Listed
    expect(list.tokens.map((t) => [t.name, t.access])).toEqual([
      ['Kari', 'write'],
      ['Ola', 'read'],
    ])
    for (const t of list.tokens) {
      expect(Object.keys(t).sort()).toEqual(['access', 'createdAt', 'name'])
      expect(Number.isNaN(Date.parse(t.createdAt))).toBe(false)
    }
  })

  it('keeps names unique (case-insensitively) and validates input', async () => {
    await createToken('Kari')
    expect((await admin('POST', '', { name: 'kari' })).status).toBe(409)
    expect((await admin('POST', '', { name: '' })).status).toBe(400)
    expect((await admin('POST', '', { name: 'x'.repeat(65) })).status).toBe(400)
    expect((await admin('POST', '', { name: 'bad/name' })).status).toBe(400)
    expect((await admin('POST', '', { name: 'Ola', access: 'admin' })).status).toBe(400)
    expect((await admin('PATCH', '/Kari', { access: 'admin' })).status).toBe(400)
    expect((await admin('PATCH', '/Nobody', { access: 'write' })).status).toBe(404)
  })

  it('revoke deletes the record; revoking again is a 404', async () => {
    await createToken('Kari')
    const res = await admin('DELETE', '/Kari')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'Kari', revokedGrants: 0 })
    expect(((await (await admin('GET')).json()) as Listed).tokens).toEqual([])
    expect((await admin('DELETE', '/Kari')).status).toBe(404)
  })
})

describe('sign-in with a personal access token', () => {
  it('asks for a personal access token, not the API secret', async () => {
    const { page } = await openSignIn(await registerClient())
    expect(page).toContain('Personal access token')
    expect(page).not.toContain('API secret')
  })

  it('accepts a valid token and serves /mcp', async () => {
    const accessToken = await signIn(await createToken('Kari'))
    expect((await initialize(accessToken)).status).toBe(200)
    expect(await toolNames(accessToken)).toEqual(READ_TOOLS)
  })

  it('rejects an invalid token, a revoked token and the shared API secret', async () => {
    const token = await createToken('Kari')
    await admin('DELETE', '/Kari')
    const { submit } = await openSignIn(await registerClient())

    for (const key of ['bb_pat_not-a-real-token', token, 'correct-key']) {
      const res = await submit(key)
      expect(res.status).toBe(401)
      expect(await res.text()).toContain('That token is not valid.')
    }
  })

  it('still rate-limits failed attempts per IP', async () => {
    const token = await createToken('Kari')
    const { submit } = await openSignIn(await registerClient(), '9.9.9.9')
    for (let i = 0; i < MAX_FAILED_PER_IP; i++) expect((await submit('wrong')).status).toBe(401)
    // Locked out even with the right token.
    expect((await submit(token)).status).toBe(429)
  })

  it('issues the grant to a per-person user with the token name in props', async () => {
    await signIn(await createToken('Kari'))
    await signIn(await createToken('Ola'))
    const api = getOAuthRoles(BASE).authServer.getOAuthApi(env)
    const grantKeys = (await env.OAUTH_KV!.list({ prefix: 'grant:' })).keys.map((k) => k.name)
    const userIds = new Set(grantKeys.map((k) => k.split(':')[1]))
    expect(userIds.size).toBe(2)
    for (const userId of userIds) {
      const { items } = await api.listUserGrants(userId!)
      expect(items).toHaveLength(1)
      expect(items[0]!.metadata.label).toMatch(/^Personal access token: (Kari|Ola)$/)
    }
  })
})

describe('revocation', () => {
  it('rejects /mcp on the next request after revoke and revokes the grants', async () => {
    const kari = await signIn(await createToken('Kari'))
    const other = await signIn(await createToken('Per'))
    expect((await initialize(kari)).status).toBe(200)

    const res = await admin('DELETE', '/Kari')
    expect(await res.json()).toEqual({ name: 'Kari', revokedGrants: 1 })

    const after = await initialize(kari)
    expect(after.status).toBe(401)
    // Other people are unaffected.
    expect((await initialize(other)).status).toBe(200)
  })

  it('does not revive old sign-ins when a token is re-created under the same name', async () => {
    const accessToken = await signIn(await createToken('Kari'))
    // Remove only the record (as if grant revocation had failed), then re-create.
    await env.OAUTH_KV!.delete('pat:name:kari')
    await createToken('Kari')
    expect((await initialize(accessToken)).status).toBe(401)
  })

  it('rejects grants from the old shared-secret sign-in (no token name in props)', async () => {
    const clientId = await registerClient()
    const api = getOAuthRoles(BASE).authServer.getOAuthApi(env)
    const authRequest = await api.parseAuthRequest(new Request(await authorizeUrl(clientId)))
    const { redirectTo } = await api.completeAuthorization({
      request: authRequest,
      userId: 'bildebank-api-secret',
      metadata: { label: 'Bildebank API secret' },
      scope: ['bildebank'],
      props: { user: 'bildebank-api-secret' },
    })
    const code = new URL(redirectTo).searchParams.get('code')!
    const accessToken = await exchangeCode(clientId, code)
    expect((await initialize(accessToken)).status).toBe(401)
  })
})

describe('access levels', () => {
  it('a read token cannot see or call upload_image', async () => {
    const accessToken = await signIn(await createToken('Kari'))
    expect(await toolNames(accessToken)).not.toContain('upload_image')
    const message = await callUpload(accessToken)
    expect(message).toMatch(/upload_image/)
    expect(message).not.toMatch(/Only https/)
  })

  it('a write token sees and can call upload_image', async () => {
    const accessToken = await signIn(await createToken('Kari', 'write'))
    expect(await toolNames(accessToken)).toEqual([...READ_TOOLS, 'upload_image'].sort())
    expect(await callUpload(accessToken)).toMatch(/Only https/)
  })

  it('set-access takes effect on the next request without signing in again', async () => {
    const accessToken = await signIn(await createToken('Kari'))
    expect(await toolNames(accessToken)).not.toContain('upload_image')

    const up = await admin('PATCH', '/Kari', { access: 'write' })
    expect(up.status).toBe(200)
    expect(await up.json()).toMatchObject({ name: 'Kari', access: 'write' })
    expect(await toolNames(accessToken)).toContain('upload_image')
    expect(await callUpload(accessToken)).toMatch(/Only https/)

    await admin('PATCH', '/Kari', { access: 'read' })
    expect(await toolNames(accessToken)).not.toContain('upload_image')
    expect(await callUpload(accessToken)).not.toMatch(/Only https/)
  })
})
