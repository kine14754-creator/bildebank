import { pgTable, uuid, text, integer, timestamp, primaryKey, jsonb, type AnyPgColumn } from 'drizzle-orm/pg-core'

// --- Folders ---
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => folders.id),
  tenantId: text('tenant_id').notNull().default('default'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// --- Images ---
export const images = pgTable('images', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(), // R2 object key, e.g. "default/2024/photo.jpg"
  filename: text('filename').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type').notNull(),
  width: integer('width'),
  height: integer('height'),
  altText: text('alt_text'),
  folderId: uuid('folder_id').references(() => folders.id),
  tenantId: text('tenant_id').notNull().default('default'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// --- Tags ---
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().default(''),
  color: text('color'),
  tenantId: text('tenant_id').notNull().default('default'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// --- Image <-> Tag (many-to-many) ---
export const imageTags = pgTable(
  'image_tags',
  {
    imageId: uuid('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.imageId, t.tagId] }),
  })
)

// --- Upload sessions (MCP create_upload_link) ---
// In Postgres rather than KV: KV reads are cached per Cloudflare location, so an
// upload recorded in one location was invisible to get_upload_session in another.
export const uploadSessions = pgTable('upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** SHA-256 of the link token; the token itself is never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  tenantId: text('tenant_id').notNull().default('default'),
  folderId: uuid('folder_id'),
  folderPath: text('folder_path'),
  tagIds: jsonb('tag_ids').$type<string[]>().notNull().default([]),
  tagNames: jsonb('tag_names').$type<string[]>().notNull().default([]),
  maxFiles: integer('max_files').notNull(),
  /** The personal access token that created the session: { tokenName, tokenId }. */
  createdBy: jsonb('created_by').$type<{ tokenName: string; tokenId: string } | null>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
})

export const uploadSessionFiles = pgTable(
  'upload_session_files',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    imageId: uuid('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    /** 'uploaded' (stored by the session) or 'existing' (same filename already there). */
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.imageId] }),
  })
)

export type Image = typeof images.$inferSelect
export type NewImage = typeof images.$inferInsert
export type Folder = typeof folders.$inferSelect
export type NewFolder = typeof folders.$inferInsert
export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert
