import { pgTable, uuid, text, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core'

// --- Folders ---
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): ReturnType<typeof uuid> => folders.id),
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

export type Image = typeof images.$inferSelect
export type NewImage = typeof images.$inferInsert
export type Folder = typeof folders.$inferSelect
export type NewFolder = typeof folders.$inferInsert
export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert
