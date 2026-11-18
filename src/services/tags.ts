/**
 * Tag logic shared by the /api/tags and /api/images/:id/tags routes and the
 * MCP tag tools (list_tags, create_tag, set_image_tags).
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { imageTags, tags, type Db, type Tag } from '../db'

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** All tags for a tenant, by name, with how many images carry each. */
export async function listTagsWithCounts(db: Db, tenantId: string) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      color: tags.color,
      tenantId: tags.tenantId,
      createdAt: tags.createdAt,
      imageCount: sql<number>`count(${imageTags.imageId})::int`,
    })
    .from(tags)
    .leftJoin(imageTags, eq(imageTags.tagId, tags.id))
    .where(eq(tags.tenantId, tenantId))
    .groupBy(tags.id)
    .orderBy(tags.name)
}

/**
 * The tag that a new tag called `name` would duplicate: same slug, or the same
 * name ignoring case (the slug alone can't tell apart names with no letters or
 * digits, which all slug to '').
 */
export async function findExistingTag(
  db: Db,
  tenantId: string,
  name: string
): Promise<Tag | undefined> {
  const trimmed = name.trim()
  const slug = toSlug(trimmed)
  const sameName = sql`lower(${tags.name}) = lower(${trimmed})`
  const [row] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.tenantId, tenantId), slug ? or(eq(tags.slug, slug), sameName) : sameName))
    .limit(1)
  return row
}

/** Insert a tag. The caller checks findExistingTag first. */
export async function insertTag(
  db: Db,
  input: { name: string; color?: string | null; tenantId: string }
): Promise<Tag> {
  const name = input.name.trim()
  const [tag] = await db
    .insert(tags)
    .values({ name, slug: toSlug(name), color: input.color ?? null, tenantId: input.tenantId })
    .returning()
  return tag as Tag
}

/** Of `tagIds`, the ones that exist in the tenant. */
export async function existingTagIds(db: Db, tenantId: string, tagIds: string[]): Promise<Set<string>> {
  if (tagIds.length === 0) return new Set()
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(inArray(tags.id, tagIds), eq(tags.tenantId, tenantId)))
  return new Set(rows.map((r) => r.id))
}

/** Attach tags to an image; tags it already has are skipped. Returns the ids actually added. */
export async function addTagsToImage(db: Db, imageId: string, tagIds: string[]): Promise<string[]> {
  if (tagIds.length === 0) return []
  const rows = await db
    .insert(imageTags)
    .values(tagIds.map((tagId) => ({ imageId, tagId })))
    .onConflictDoNothing()
    .returning({ tagId: imageTags.tagId })
  return rows.map((r) => r.tagId)
}

/** Detach tags from an image. Returns the ids actually removed. */
export async function removeTagsFromImage(
  db: Db,
  imageId: string,
  tagIds: string[]
): Promise<string[]> {
  if (tagIds.length === 0) return []
  const rows = await db
    .delete(imageTags)
    .where(and(eq(imageTags.imageId, imageId), inArray(imageTags.tagId, tagIds)))
    .returning({ tagId: imageTags.tagId })
  return rows.map((r) => r.tagId)
}
