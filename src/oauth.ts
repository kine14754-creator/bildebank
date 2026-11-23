/**
 * OAuth 2.1 in front of /mcp, in this same worker.
 *
 * A copy of the Broadcast MCP's oauth.ts (nimlas-sites/packages/broadcast-worker)
 * with only the names, scope and key changed. Cloudflare's split-role layout
 * (OAuthAuthorizationServer + OAuthResourceServer from
 * @cloudflare/workers-oauth-provider), dispatched by path before the Hono app,
 * so the API-key routes (/api/*, /files/*) never pass through the OAuth code:
 *
 *   /mcp, /mcp/*                               → resource server → MCP handler
 *   /.well-known/oauth-protected-resource[/mcp] → resource server (RFC 9728)
 *   /.well-known/*, /oauth/token, /oauth/register → authorization server
 *   /authorize                                  → our sign-in page (below)
 *
 * Each person signs in with their own named personal access token (src/tokens.ts),
 * created and revoked through the admin routes (src/routes/admin.ts). The grant is
 * issued to that token's own userId with the token name in props, and every /mcp
 * request re-checks that the token still exists — so revoking a token cuts access
 * on the next request. The shared API_SECRET is not accepted on the sign-in page;
 * it only guards /api/*. The admin routes use their own ADMIN_SECRET. There is no third-party identity
 * provider.
 */
import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import type { Env } from './types'
import { createBildebankMcpServer } from './mcp'
import {
  accessOf,
  findTokenByRawToken,
  resolveTokenGrant,
  userIdFor,
  type TokenProps,
} from './tokens'

export const MCP_PATH = '/mcp'
export const AUTHORIZE_PATH = '/authorize'
export const TOKEN_PATH = '/oauth/token'
export const REGISTER_PATH = '/oauth/register'
export const SCOPE = 'bildebank'

// ── Redirect URIs ───────────────────────────────────────────────────────────

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

/**
 * The only places a code may be sent: claude.ai's callback, and Claude Code's
 * loopback callback on any port (RFC 8252 §7.3) — on localhost and 127.0.0.1.
 * Checked both at registration (DCR) and on every authorization request, so a
 * CIMD client or a client registered with other URIs can't get a code elsewhere.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return true
  const m = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?\/callback$/.exec(uri)
  return !!m && (m[1] === undefined || (Number(m[1]) >= 1 && Number(m[1]) <= 65535))
}

// ── Provider instances (per public origin) ──────────────────────────────────

interface OAuthRoles {
  origin: string
  resource: string
  authServer: OAuthAuthorizationServer<Env>
  resourceServer: OAuthResourceServer<Env, Record<string, unknown>>
}

const roles = new Map<string, OAuthRoles>()

/**
 * The issuer and resource must be canonical URLs fixed at construction, and the
 * worker's URL isn't known until a request arrives — so the roles are built on
 * first use per origin. PUBLIC_ORIGIN pins it (set it once a custom domain is in
 * front of the worker); otherwise the request's own origin is used, which on
 * workers.dev and `wrangler dev` is the URL the client connected to.
 */
export function publicOrigin(request: Request, env: Env): string {
  const configured = typeof env.PUBLIC_ORIGIN === 'string' ? env.PUBLIC_ORIGIN.trim() : ''
  return (configured || new URL(request.url).origin).replace(/\/+$/, '').toLowerCase()
}

export function getOAuthRoles(origin: string): OAuthRoles {
  const cached = roles.get(origin)
  if (cached) return cached

  const resource = `${origin}${MCP_PATH}`

  const authServer = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [resource],
    defaultResource: resource,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // Both registration styles Claude uses: DCR (RFC 7591) and Client ID
    // Metadata Documents (needs the global_fetch_strictly_public flag).
    clientRegistrationEndpoint: REGISTER_PATH,
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE],
    accessTokenTTL: 60 * 60,
    // Refresh tokens rotate on every use (library behaviour); a grant lives as
    // long as it keeps being used, and lapses after 30 idle days.
    refreshTokenTTL: 90 * 24 * 60 * 60,
    refreshTokenIdleTTL: 30 * 24 * 60 * 60,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris
      if (
        !Array.isArray(uris) ||
        uris.length === 0 ||
        !uris.every((u) => typeof u === 'string' && isAllowedRedirectUri(u))
      ) {
        return {
          code: 'invalid_redirect_uri',
          description: `Only ${CLAUDE_CALLBACK} and http://localhost|127.0.0.1:<port>/callback are accepted.`,
        }
      }
    },
  })

  const resourceServer = new OAuthResourceServer<Env, Record<string, unknown>>({
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'Bildebank',
    },
    requiredScopes: [SCOPE],
    // The library checks the token itself; on top of that, the personal access
    // token it was issued for must still exist. A revoked token, or a grant from
    // before personal tokens (no tokenName in props), gets a 401. The access
    // level comes from the same lookup, not from the grant, so a change made
    // with set-access applies on the next request.
    validateToken: (env) => async (res, token) => {
      const result = await authServer.validateToken(res, token, env)
      if (!result || !env.OAUTH_KV) return null
      const record = await resolveTokenGrant(env.OAUTH_KV, result.props)
      if (!record) return null
      const props = (result.props ?? {}) as Record<string, unknown>
      return { ...result, props: { ...props, access: accessOf(record) } }
    },
    handler: {
      fetch(request, env, ctx) {
        // Stateless: a fresh MCP server per request, as the agents docs require.
        // Anything but an explicit "write" from the validator is read-only.
        const access = ctx.props?.access === 'write' ? 'write' : 'read'
        // Which personal access token is calling, so writes can be attributed.
        const { tokenName, tokenId } = (ctx.props ?? {}) as Partial<TokenProps>
        const actor =
          typeof tokenName === 'string' && typeof tokenId === 'string'
            ? { tokenName, tokenId }
            : undefined
        const handler = createMcpHandler(() => createBildebankMcpServer(env, origin, access, actor), {
          route: MCP_PATH,
          authContext: { props: (ctx.props ?? {}) as Record<string, unknown> },
        })
        return handler(request, env, ctx)
      },
    },
  })

  const created = { origin, resource, authServer, resourceServer }
  roles.set(origin, created)
  return created
}

// ── Router ──────────────────────────────────────────────────────────────────

const isResourcePath = (p: string) =>
  p === MCP_PATH ||
  p.startsWith(`${MCP_PATH}/`) ||
  p === '/.well-known/oauth-protected-resource' ||
  p.startsWith('/.well-known/oauth-protected-resource/')

const isAuthServerPath = (p: string) =>
  p.startsWith('/.well-known/') || p === TOKEN_PATH || p === REGISTER_PATH

/**
 * Revoke every OAuth grant (and with it every access and refresh token) issued
 * to one user. Returns how many grants were revoked.
 */
export async function revokeAllGrants(api: OAuthHelpers, userId: string): Promise<number> {
  // Collect first, then revoke: deleting while paging could skip entries.
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await api.listUserGrants(userId, { cursor })
    ids.push(...page.items.map((g) => g.id))
    cursor = page.cursor
  } while (cursor)
  for (const id of ids) await api.revokeGrant(id, userId)
  return ids.length
}

/**
 * Handle the MCP and OAuth paths; `null` for every other path, which the worker's
 * existing router then handles exactly as before.
 */
export async function handleOAuthAndMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const resource = isResourcePath(pathname)
  const authorize = pathname === AUTHORIZE_PATH
  if (!resource && !authorize && !isAuthServerPath(pathname)) return null

  if (!env.OAUTH_KV) {
    return new Response(
      'MCP is not configured on this worker: the OAUTH_KV namespace binding is missing.',
      { status: 503 }
    )
  }

  const { authServer, resourceServer } = getOAuthRoles(publicOrigin(request, env))
  if (resource) return resourceServer.fetch(request, env, ctx)
  if (authorize) return handleAuthorize(request, env, authServer.getOAuthApi(env))
  return authServer.fetch(request, env, ctx)
}

// ── Sign-in page ────────────────────────────────────────────────────────────

/** Failed sign-ins allowed per client IP, and across all IPs, per window. */
export const MAX_FAILED_PER_IP = 5
export const MAX_FAILED_GLOBAL = 50
const RATE_WINDOW_SECONDS = 15 * 60

const rateKeys = (ip: string) => [`signin-fail:ip:${ip}`, 'signin-fail:global'] as const

async function isRateLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  const [ipKey, globalKey] = rateKeys(ip)
  const [ipCount, globalCount] = await Promise.all([kv.get(ipKey), kv.get(globalKey)])
  return Number(ipCount ?? 0) >= MAX_FAILED_PER_IP || Number(globalCount ?? 0) >= MAX_FAILED_GLOBAL
}

async function recordFailure(kv: KVNamespace, ip: string): Promise<void> {
  // KV is eventually consistent, so this is a brake, not an exact counter — enough
  // to make guessing a long random key hopeless.
  await Promise.all(
    rateKeys(ip).map(async (key) => {
      const n = Number((await kv.get(key)) ?? 0) + 1
      await kv.put(key, String(n), { expirationTtl: RATE_WINDOW_SECONDS })
    })
  )
}

const encoder = new TextEncoder()

/**
 * Compare two secrets (or secret hashes) in constant time. Both sides are
 * hashed first, so the comparison always runs over 32 bytes whatever the input
 * length, and the XOR loop never exits early.
 */
export async function keysMatch(submitted: string, expected: string): Promise<boolean> {
  if (!expected) return false
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(submitted)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

function page(body: string, status = 200, extra?: Headers): Response {
  const headers = new Headers(PAGE_HEADERS)
  extra?.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') headers.append(key, value)
    else headers.set(key, value)
  })
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bildebank — sign in</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 26rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.3rem; }
  .host { font-family: ui-monospace, monospace; font-weight: 600; word-break: break-all; }
  .warn { border-left: 3px solid #c80; padding-left: .75rem; }
  .error { color: #c22; font-weight: 600; }
  label, input, button { display: block; width: 100%; box-sizing: border-box; font: inherit; }
  input { margin: .25rem 0 1rem; padding: .5rem; }
  button { padding: .6rem; cursor: pointer; }
</style></head><body>${body}</body></html>`
  return new Response(html, { status, headers })
}

function errorPage(message: string, status = 400): Response {
  return page(`<h1>Can't sign in</h1><p class="error">${escapeHtml(message)}</p>`, status)
}

function signInPage(
  request: Request,
  consent: ConsentDescription,
  handle: string,
  headers: Headers,
  error?: string,
  status = 200
): Response {
  const action = `${AUTHORIZE_PATH}${new URL(request.url).search}`
  const client = consent.clientDomain
    ? `${escapeHtml(consent.clientName)} (${escapeHtml(consent.clientDomain)})`
    : escapeHtml(consent.clientName)
  const body = `
<h1>Allow access to Bildebank</h1>
<p><strong>${client}</strong> is asking to browse, view and upload images in the Bildebank
image library.</p>
<p>After you sign in you will be sent to:<br><span class="host">${escapeHtml(consent.redirectHost)}</span></p>
${
  consent.redirectIsLoopback
    ? '<p class="warn">That is an app on this computer (such as Claude Code). Only continue if you just started this sign-in yourself.</p>'
    : ''
}
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(action)}">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <label for="key">Personal access token</label>
  <input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required autofocus>
  <button type="submit">Allow</button>
</form>`
  return page(body, status, headers)
}

async function parseAuth(
  request: Request,
  api: OAuthHelpers
): Promise<{ authRequest: AuthRequest } | { response: Response }> {
  let authRequest: AuthRequest
  try {
    authRequest = await api.parseAuthRequest(request)
  } catch (err) {
    // Only redirect when the library validated the client and redirect URI;
    // otherwise the error is shown here and nothing leaves this page.
    if (
      err instanceof AuthorizationError &&
      err.redirectTo &&
      isAllowedRedirectUri(err.redirectUri ?? '')
    ) {
      return { response: Response.redirect(err.redirectTo, 302) }
    }
    return {
      response: errorPage(err instanceof Error ? err.message : 'Invalid authorization request'),
    }
  }
  if (!isAllowedRedirectUri(authRequest.redirectUri)) {
    return {
      response: errorPage(
        `This server only sends sign-ins back to Claude (${CLAUDE_CALLBACK}) or Claude Code on this computer.`
      ),
    }
  }
  return { authRequest }
}

export async function handleAuthorize(
  request: Request,
  env: Env,
  api: OAuthHelpers
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const parsed = await parseAuth(request, api)
  if ('response' in parsed) return parsed.response
  const { authRequest } = parsed
  const consent = await api.describeConsent(authRequest)

  if (request.method === 'GET') {
    const { handle, headers } = await api.beginConsent(authRequest)
    return signInPage(request, consent, handle, headers)
  }

  // POST: the form posts back to the same URL (query string included), so a wrong
  // token can re-render the page from the original request.
  const kv = env.OAUTH_KV!
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  const retry = async (message: string, status: number) => {
    const { handle, headers } = await api.beginConsent(authRequest)
    return signInPage(request, consent, handle, headers, message, status)
  }

  if (await isRateLimited(kv, ip)) {
    return retry('Too many failed attempts. Wait 15 minutes and try again.', 429)
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return retry('The form could not be read. Try again.', 400)
  }
  const key = String(form.get('key') ?? '').trim()
  const handle = String(form.get('handle') ?? '')

  // Looked up by SHA-256 hash; the stored hash is then compared in constant time.
  const record = key ? await findTokenByRawToken(kv, key, keysMatch) : null
  if (!record) {
    await recordFailure(kv, ip)
    return retry('That token is not valid.', 401)
  }

  let approved
  try {
    // Verifies the browser-bound consent cookie against the posted handle (CSRF),
    // and works once.
    approved = await api.approveConsent(request, handle, { scope: [SCOPE] })
  } catch (err) {
    return retry(
      err instanceof AuthorizationError
        ? 'This sign-in page expired. Enter the token again.'
        : `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
      400
    )
  }

  const userId = userIdFor(record)
  const props: TokenProps = {
    user: userId,
    tokenName: record.name,
    tokenId: record.id,
    access: accessOf(record),
  }
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId,
    metadata: { label: `Personal access token: ${record.name}` },
    scope: [SCOPE],
    props,
  })

  const headers = new Headers(approved.headers)
  headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers })
}
