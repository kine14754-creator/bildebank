# Bildebank

Image library on Cloudflare Workers: Hono API, R2 for files, Neon Postgres (drizzle) for
metadata. Used by Sanity Studio through `@fmweb/sanity-bildebank`, and by Claude through
the MCP server at `/mcp`.

Run `npm run help` for a short overview of every command in this repo (npm scripts, token
management, the local database, dev/deploy, tests) with examples.

| Path            | Auth                         | What                                   |
| --------------- | ---------------------------- | -------------------------------------- |
| `/health`       | none                         | Health check                           |
| `/files/*`      | none                         | Public image files from R2             |
| `/api/*`        | `Authorization: Bearer <API_SECRET>` | Images, folders, tags (Studio plugin) |
| `/admin/mcp-tokens` | `Authorization: Bearer <ADMIN_SECRET>` | Create, list, change and revoke personal access tokens for `/mcp` |
| `/mcp`          | OAuth 2.1 (sign in with a personal access token) | MCP server for Claude |
| `/upload/<token>` | the token in the link (from `create_upload_link`) | `GET`: upload page in the browser. `POST`: one file (multipart field `file`), used by the page or by Claude directly |

## Development

```bash
npm install --legacy-peer-deps
cp .dev.vars.example .dev.vars   # fill in DATABASE_URL, API_SECRET and ADMIN_SECRET
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
| `list_tags`     | All tags: id, name, image count. Use the ids with `search_images`, `upload_image` and `set_image_tags` |
| `create_tag`    | **Write access only.** Create a tag by name; returns the existing tag (`existing: true`) if the name is taken, ignoring case |
| `set_image_tags` | **Write access only.** Add (`addTagIds`) and/or remove (`removeTagIds`) tags on one image; other tags are left alone |
| `get_upload_session` | Images uploaded through a `create_upload_link` link: `images` (id, filename, url, altText), `alreadyInLibrary` (files skipped because the filename existed), `expired`, `remaining`. Readable for 24 hours |
| `upload_image`  | **Write access only.** Fetch a public https URL server-side and store it like `POST /api/images/upload`. Returns the existing image (`existing: true`) if the filename is taken, unless `force: true` |
| `create_upload_link` | **Write access only.** For image files rather than URLs: `folderId?`, `tagIds?` → `{ url, uploadEndpoint, fileField, forceField, expiresAt, sessionId, maxFiles }`. Claude posts files it can read straight to `uploadEndpoint`; otherwise the user opens `url`. Up to 50 files within 30 minutes (see below) |
| `update_image`  | **Write access only.** Change `altText`, `filename` and/or `folderId` on one image (only the fields given; an empty `altText` clears it). Returns the same metadata as `get_image`. Tags stay in `set_image_tags` |

There are no delete tools (removing a tag from an image is the only removal); `update_image`
is the only way to rename an image or move it to another folder.
The tag tools use the same service as the `/api/tags` routes (`src/services/tags.ts`). Tools that change data are only registered for
tokens with write access, and refuse read tokens if called anyway; any new tool that mutates
data must go inside `writeTools()` and call `requireWrite()` (see `src/mcp.ts`).

**`view_image` resizing** uses the Cloudflare Images binding (`IMAGES` in `wrangler.toml`),
which works on workers.dev. Without the binding it falls back to the stored original when
that is already a raster image under 150 KB. SVGs are never shown as pictures.

**`upload_image` limits:** JPEG/PNG/WebP/SVG only (Content-Type and magic bytes are both
checked), max 20 MB (checked against Content-Length and while streaming), `https://` on
port 443 only, no embedded credentials, and no localhost / internal names / private, link-local
or reserved IPs / IPv6 literals. Redirects are followed by hand (max 5) and each hop is
checked again; the `global_fetch_strictly_public` flag keeps the fetch on the public internet.

**Upload links (`create_upload_link`).** MCP tool calls can't carry files and the server can't
read anyone's files, so `create_upload_link` creates an upload session and returns
`/upload/<token>` twice: as `url`, a minimal drag-and-drop / file-picker page served by this
worker (`src/routes/uploadPage.ts`), and as `uploadEndpoint`, the same URL that the page POSTs
to. When Claude has the files in its own workspace (attached in the chat, or in a connected
folder), it posts them straight to `uploadEndpoint`, one at a time, with no browser involved:

```bash
curl -F "file=@photo.jpg;type=image/jpeg" "$uploadEndpoint"   # add -F force=1 to upload a duplicate filename anyway
```

The page is for when Claude can't reach the files. Answers are JSON: `201 { status: "uploaded",
image }`, `200 { status: "existing", image }` (an image with that filename exists; nothing stored)
or `4xx { status: "error", error }`. There is no sign-in: the random token in the link is the only
credential, and it only allows uploading into that session — up to 50 files, for 30 minutes.
Each file is posted on its own
and goes through the same pipeline as `POST /api/images/upload` (`storeImage`: JPEG/PNG/WebP/SVG,
max 20 MB, WebP handling), with `upload_image`'s magic-byte check and same-filename check, and
gets the session's folder and tags. The page shows success or failure per file; a file whose
filename already exists is skipped, with an "Upload anyway" button. Afterwards Claude calls
`get_upload_session` to get the new image ids and continue with `update_image` and
`set_image_tags`.

Sessions live in `OAUTH_KV` under `upload:` (`src/uploadSessions.ts`): only the SHA-256 of the
link token is stored, and that index expires with the link; the session and its file list are
kept for 24 hours so `get_upload_session` still works afterwards. The session records which
personal access token created it. KV is eventually consistent, so the 50-file limit is exact
only because uploads are sent one at a time (the page does this, and the tool description tells
Claude to).

**Attribution.** Every write through `/mcp` (`upload_image`, `create_upload_link`,
`update_image`, `create_tag`, `set_image_tags`) logs one JSON line with `event: "mcp.write"`,
the tool and the personal access token's name and id; each file uploaded through a link logs
`event: "upload_link.upload"` with the token that created the link. Read them with
`npx wrangler tail`.

**Sign-in** is OAuth 2.1. The `/authorize` page asks for a **personal access token**: one per
person, named, created by the admin with `npm run mcp-token` (below). The shared `API_SECRET`
is not accepted on the sign-in page. Five wrong attempts from one IP lock it out for 15
minutes. Codes are only sent to `https://claude.ai/api/mcp/auth_callback` or Claude Code's
`http://localhost|127.0.0.1:<port>/callback`. Requests to `/mcp` without a token issued by
this flow get `401` (neither the raw API secret nor a personal access token is accepted as a
bearer token there).

Each grant is issued to that person's own user id with the token name in its props, and every
`/mcp` request looks the token up again: a revoked token gets `401` on its next request, and
its OAuth grants are deleted too. Sign-ins made before personal tokens (with the API secret)
are rejected and must sign in again with a token.

### Personal access tokens

Tokens live in `OAUTH_KV` (`src/tokens.ts`): name (unique, case-insensitive), creation time,
access level and the SHA-256 hash of the token — the token itself is never stored and is only
shown once, when it is created.

| Access  | What the person can do                         |
| ------- | ---------------------------------------------- |
| `read`  | Default. Browse, search and view images        |
| `write` | Everything `read` can, plus `upload_image`, `create_upload_link`, `update_image`, `create_tag` and `set_image_tags` |

The access level is read from the store on every request, so `set-access` applies on the
person's next request without reconnecting. (Cloudflare KV is eventually consistent: a change
is immediate where it was made, and can take up to about a minute to reach every Cloudflare
location.)

```bash
npm run mcp-token -- create "Kari Nordmann"           # read access; prints the token once
npm run mcp-token -- create "Kari Nordmann" --write   # read + write
npm run mcp-token -- list                             # name, access, created — no tokens
npm run mcp-token -- set-access "Kari Nordmann" write # or read
npm run mcp-token -- revoke "Kari Nordmann"           # deletes the token and its sign-ins
```

The script calls the `/admin/mcp-tokens` routes. It reads `ADMIN_SECRET` and, optionally,
`BILDEBANK_URL` (default `https://bildebank.filipkronstad.workers.dev`) from the environment
or from a `.env` file in the project root (gitignored). Give each person their token over a
private channel.

Admin API (all `Authorization: Bearer <ADMIN_SECRET>`). `ADMIN_SECRET` is a separate worker
secret from `API_SECRET` on purpose: `API_SECRET` ships to browsers in the Studio plugin, and
holding it must not let anyone mint MCP tokens. The API secret is rejected here, and without
`ADMIN_SECRET` configured the routes answer `503`.

| Method & path                     | Body                    | Returns |
| --------------------------------- | ----------------------- | ------- |
| `POST /admin/mcp-tokens`          | `{ name, access? }`     | `201 { name, createdAt, access, token }` |
| `GET /admin/mcp-tokens`           |                         | `{ tokens: [{ name, createdAt, access }] }` |
| `PATCH /admin/mcp-tokens/:name`   | `{ access }`            | `{ name, createdAt, access }` |
| `DELETE /admin/mcp-tokens/:name`  |                         | `{ name, revokedGrants }` |

MCP clients call `/mcp` server-to-server, so no CORS origin is needed for them; the OAuth
paths are handled before the Hono app and its `cors()` config. The `/upload/<token>` page posts
to its own origin, so it needs no CORS entry either.

### One-time setup

```bash
npx wrangler kv namespace create OAUTH_KV   # paste the printed id into wrangler.toml
npx wrangler deploy
```

One new secret for the admin routes: `npx wrangler secret put ADMIN_SECRET` (a long random
value; also put it in `.env` for `npm run mcp-token`). After deploying, create a token for
each person with `npm run mcp-token -- create "<name>"`. The Images binding needs no
setup beyond `wrangler.toml` (Images transformations are billed per unique transformation,
with a free monthly allowance).

### Add it to Claude

- **claude.ai / Desktop:** Customize → Connectors → **Add custom connector**. URL:
  `https://bildebank.filipkronstad.workers.dev/mcp` (the exact URL, including `/mcp`). Leave
  the OAuth client settings on the default. Click **Add**, then **Connect**, and paste your
  personal access token on the sign-in page.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user bildebank https://bildebank.filipkronstad.workers.dev/mcp
  ```

  Then run `/mcp` in Claude Code → `bildebank` → **Authenticate** and paste your personal
  access token in the browser.

Ask the Bildebank admin for a token first. If you were connected before personal tokens were
introduced, disconnect and connect again with your token.

If the worker moves behind a custom domain, set `PUBLIC_ORIGIN` under `[vars]` in
`wrangler.toml` and re-add the connector with the new URL — tokens are bound to the URL.
