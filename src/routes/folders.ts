import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, folders, images } from '../db'
import type { Env } from '../types'

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

// PATCH /:id — gi nytt navn
folderRoutes.patch('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  let body: { name?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const [existing] = await db.select().from(folders).where(eq(folders.id, id)).limit(1)
  if (!existing) return c.json({ error: 'Folder not found' }, 404)
  const [updated] = await db
    .update(folders)
    .set({ name: body.name.trim(), updatedAt: new Date() })
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
    return c.json({ error: 'Slett undermapper først' }, 409)
  }

  // Nullstill folderId for bilder i denne mappen
  await db
    .update(images)
    .set({ folderId: null })
    .where(eq(images.folderId, id))

  await db.delete(folders).where(eq(folders.id, id))
  return c.json({ success: true })
})
