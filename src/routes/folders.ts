import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, folders, images } from '../db'
import type { Env } from '../types'

/** Henter rekursivt alle etterkommer-ID-er for en mappe */
async function getDescendantIds(
  db: ReturnType<typeof createDb>,
  folderId: string
): Promise<string[]> {
  const children = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.parentId, folderId))
  const result: string[] = []
  for (const child of children) {
    result.push(child.id)
    const grandchildren = await getDescendantIds(db, child.id)
    result.push(...grandchildren)
  }
  return result
}

export const folderRoutes = new Hono<{ Bindings: Env }>()

// GET / — list alle mapper (flat, filtrert på tenantId)
folderRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const tenantId = c.req.query('tenantId') || 'default'
  const rows = await db
    .select()
    .from(folders)
    .where(eq(folders.tenantId, tenantId))
    .orderBy(folders.name)
  return c.json({ data: rows })
})

// POST / — opprett mappe
folderRoutes.post('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  let body: { name?: string; parentId?: string; tenantId?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const tenantId = body.tenantId || 'default'
  const [folder] = await db
    .insert(folders)
    .values({
      name: body.name.trim(),
      parentId: body.parentId ?? undefined,
      tenantId,
    })
    .returning()
  return c.json(folder, 201)
})

// PATCH /:id — gi nytt navn og/eller flytt til ny forelder
folderRoutes.patch('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  let body: { name?: string; parentId?: string | null }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!body.name?.trim() && body.parentId === undefined) {
    return c.json({ error: 'name eller parentId er påkrevd' }, 400)
  }
  const [existing] = await db.select().from(folders).where(eq(folders.id, id)).limit(1)
  if (!existing) return c.json({ error: 'Folder not found' }, 404)

  // Sirkelreferanse-validering
  if (body.parentId !== undefined && body.parentId !== null) {
    if (body.parentId === id) {
      return c.json({ error: 'En mappe kan ikke være sin egen forelder' }, 400)
    }
    const descendants = await getDescendantIds(db, id)
    if (descendants.includes(body.parentId)) {
      return c.json({ error: 'Sirkelreferanse: valgt forelder er en etterkommer av denne mappen' }, 400)
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name?.trim()) updates.name = body.name.trim()
  if (body.parentId !== undefined) updates.parentId = body.parentId ?? null

  const [updated] = await db
    .update(folders)
    .set(updates)
    .where(eq(folders.id, id))
    .returning()
  return c.json(updated)
})

// DELETE /:id — slett mappe
// Avviser om det finnes undermapper. Nullstiller folderId på bilder i mappen.
folderRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  const [existing] = await db.select().from(folders).where(eq(folders.id, id)).limit(1)
  if (!existing) return c.json({ error: 'Folder not found' }, 404)

  // Sjekk om det finnes undermapper
  const children = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.parentId, id))
    .limit(1)
  if (children.length > 0) {
    return c.json({ error: 'Delete subfolders first' }, 409)
  }

  // Nullstill folderId for bilder i denne mappen
  await db
    .update(images)
    .set({ folderId: null })
    .where(eq(images.folderId, id))

  await db.delete(folders).where(eq(folders.id, id))
  return c.json({ success: true })
})
