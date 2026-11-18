#!/usr/bin/env node
/**
 * Manage personal access tokens for the Bildebank MCP sign-in.
 * A thin wrapper over the worker's /admin/mcp-tokens routes.
 *
 *   npm run mcp-token -- create "<name>" [--write]
 *   npm run mcp-token -- list
 *   npm run mcp-token -- set-access "<name>" read|write
 *   npm run mcp-token -- revoke "<name>"
 *
 * Config (environment variables, or a .env file in the project root):
 *   API_SECRET      the worker's API secret (required)
 *   BILDEBANK_URL   worker URL (default https://bildebank.filipkronstad.workers.dev)
 */
import { existsSync, readFileSync } from 'node:fs'

const DEFAULT_URL = 'https://bildebank.filipkronstad.workers.dev'

function loadDotEnv() {
  const path = new URL('../.env', import.meta.url)
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    let value = m[2]
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}

const USAGE = `Usage:
  npm run mcp-token -- create "<name>" [--write]
  npm run mcp-token -- list
  npm run mcp-token -- set-access "<name>" read|write
  npm run mcp-token -- revoke "<name>"`

function fail(message) {
  console.error(message)
  process.exit(1)
}

const dotEnv = loadDotEnv()
const env = (key) => process.env[key] || dotEnv[key] || ''
const baseUrl = (env('BILDEBANK_URL') || DEFAULT_URL).replace(/\/+$/, '')
const secret = env('API_SECRET')

async function call(method, path, body) {
  if (!secret) fail('API_SECRET is not set. Put it in the environment or in .env.')
  let res
  try {
    res = await fetch(`${baseUrl}/admin/mcp-tokens${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    fail(`Could not reach ${baseUrl}: ${err instanceof Error ? err.message : err}`)
  }
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { error: text }
  }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (check API_SECRET)' : ''
    fail(`Error ${res.status}${hint}: ${data.error ?? text}`)
  }
  return data
}

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((a) => a.startsWith('--')))
const args = rest.filter((a) => !a.startsWith('--'))
const name = args[0]
const needName = () => {
  if (!name) fail(`A name is required.\n\n${USAGE}`)
  return encodeURIComponent(name)
}

switch (command) {
  case 'create': {
    needName()
    const unknown = [...flags].filter((f) => f !== '--write')
    if (unknown.length) fail(`Unknown option ${unknown.join(', ')}.\n\n${USAGE}`)
    const access = flags.has('--write') ? 'write' : 'read'
    const data = await call('POST', '', { name, access })
    console.log(`Created token "${data.name}" (${data.access} access).\n`)
    console.log(`  ${data.token}\n`)
    console.log('Copy it now: it cannot be shown again. Give it to the person over a private channel;')
    console.log('they paste it on the Bildebank sign-in page when connecting Claude to /mcp.')
    break
  }
  case 'list': {
    const { tokens } = await call('GET', '')
    if (!tokens.length) {
      console.log('No tokens.')
      break
    }
    const width = Math.max(4, ...tokens.map((t) => t.name.length))
    console.log(`${'NAME'.padEnd(width)}  ACCESS  CREATED`)
    for (const t of tokens) {
      console.log(`${t.name.padEnd(width)}  ${t.access.padEnd(6)}  ${t.createdAt}`)
    }
    break
  }
  case 'set-access': {
    const encoded = needName()
    const access = args[1]
    if (access !== 'read' && access !== 'write') fail(`Access must be "read" or "write".\n\n${USAGE}`)
    const data = await call('PATCH', `/${encoded}`, { access })
    console.log(`Token "${data.name}" now has ${data.access} access (from its next request).`)
    break
  }
  case 'revoke': {
    const encoded = needName()
    const data = await call('DELETE', `/${encoded}`)
    console.log(
      `Revoked token "${data.name}" and ${data.revokedGrants} sign-in(s) made with it.`
    )
    break
  }
  default:
    fail(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE)
}
