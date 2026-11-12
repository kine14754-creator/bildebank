# Bildebank

Image library on Cloudflare Workers: Hono API, R2 for files, Neon Postgres (drizzle) for
metadata. Used by Sanity Studio through `@fmweb/sanity-bildebank`, and by Claude through
the MCP server at `/mcp`.

| Path            | Auth                         | What                                   |
| --------------- | ---------------------------- | -------------------------------------- |
| `/health`       | none                         | Health check                           |
| `/files/*`      | none                         | Public image files from R2             |
| `/api/*`        | `Authorization: Bearer <API_SECRET>` | Images, folders, tags (Studio plugin) |
| `/mcp`          | OAuth 2.1 (sign in with `API_SECRET`) | MCP server for Claude           |

## Development

```bash
npm install --legacy-peer-deps
cp .dev.vars.example .dev.vars   # fill in DATABASE_URL and API_SECRET
npm run dev                      # wrangler dev on http://localhost:8787
npm test                         # vitest (in-memory Postgres via PGlite)
```

No Neon database at hand? `npm run dev:db` starts a local stand-in for Neon's HTTP endpoint
(PGlite, with the drizzle migrations applied; data in `.wrangler/local-neon`). Point
`.dev.vars` at it with `DATABASE_URL=postgresql://postgres:postgres@localhost:4444/bildebank`
(`PORT=… npm run dev:db` if 4444 is taken — keep the URL's port in sync).

## MCP server (Claude)

`/mcp` lets Claude browse, look at and upload images. It mirrors the Broadcast MCP in
`nimlas-sites/packages/broadcast-worker`: Streamable HTTP via `agents`' `createMcpHandler`,
tools registered on an `McpServer` with zod schemas, and OAuth 2.1 from
`@cloudflare/workers-oauth-provider` in the same worker. Code: `src/mcp.ts` (tools) and
`src/oauth.ts` (sign-in). The tools call the service layer in `src/services/` directly —
the same code the `/api` routes use — and always work on tenant `default`.

| Tool            | What it does                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `list_folders`  | Folder tree (flat): id, name, parentId, path, image count direct + recursive. `parentId?` limits it to a subtree |
| `search_images` | Search by filename/alt text, `folderId` (recursive by default), `tagIds`; 25 per page (max 50) with `nextCursor`. **Text only** |
| `view_image`    | 1–6 ids → each image as an MCP image block (WebP, longest side `maxSize`, default 512, max 1024, ≤150 KB) plus id/filename/url |
| `get_image`     | Full metadata for one image, plus `sanity: { kind: 'url', url, source: { id, name: 'bildebank', url } }` |
| `upload_image`  | Fetch a public https URL server-side and store it like `POST /api/images/upload`. Returns the existing image (`existing: true`) if the filename is taken, unless `force: true` |

There are no delete, move or rename tools.

**`view_image` resizing** uses the Cloudflare Images binding (`IMAGES` in `wrangler.toml`),
which works on workers.dev. Without the binding it falls back to the stored original when
that is already a raster image under 150 KB. SVGs are never shown as pictures.

**`upload_image` limits:** JPEG/PNG/WebP/SVG only (Content-Type and magic bytes are both
checked), max 20 MB (checked against Content-Length and while streaming), `https://` on
port 443 only, no embedded credentials, and no localhost / internal names / private, link-local
or reserved IPs / IPv6 literals. Redirects are followed by hand (max 5) and each hop is
checked again; the `global_fetch_strictly_public` flag keeps the fetch on the public internet.

**Sign-in** is OAuth 2.1. The `/authorize` page asks for the worker's `API_SECRET` — the same
key the Studio plugin uses. Five wrong attempts from one IP lock it out for 15 minutes. Codes
are only sent to `https://claude.ai/api/mcp/auth_callback` or Claude Code's
`http://localhost|127.0.0.1:<port>/callback`. Requests to `/mcp` without a token issued by
this flow get `401` (the raw API secret is not accepted as a bearer token there).

MCP clients call `/mcp` server-to-server, so no CORS origin is needed for them; the OAuth
paths are handled before the Hono app and its `cors()` config.

### One-time setup

```bash
npx wrangler kv namespace create OAUTH_KV   # paste the printed id into wrangler.toml
npx wrangler deploy
```

No new secrets: the sign-in checks the existing `API_SECRET`. The Images binding needs no
setup beyond `wrangler.toml` (Images transformations are billed per unique transformation,
with a free monthly allowance).

### Add it to Claude

- **claude.ai / Desktop:** Customize → Connectors → **Add custom connector**. URL:
  `https://bildebank.filipkronstad.workers.dev/mcp` (the exact URL, including `/mcp`). Leave
  the OAuth client settings on the default. Click **Add**, then **Connect**, and enter the
  API secret on the sign-in page.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user bildebank https://bildebank.filipkronstad.workers.dev/mcp
  ```

  Then run `/mcp` in Claude Code → `bildebank` → **Authenticate** and enter the API secret in
  the browser.

If the worker moves behind a custom domain, set `PUBLIC_ORIGIN` under `[vars]` in
`wrangler.toml` and re-add the connector with the new URL — tokens are bound to the URL.
