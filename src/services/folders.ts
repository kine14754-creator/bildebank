import { eq, sql } from 'drizzle-orm'
import { folders, images, type Db } from '../db'

export interface FolderRef {
  id: string
  parentId: string | null
}

/**
 * Collects a folder id together with every folder beneath it, breadth-first.
 * Guards against cycles so a corrupt parent chain cannot hang the request.
 */
export function collectFolderSubtree(all: FolderRef[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const folder of all) {
    if (!folder.parentId) continue
    const bucket = childrenByParent.get(folder.parentId)
    if (bucket) bucket.push(folder.id)
    else childrenByParent.set(folder.parentId, [folder.id])
  }

  const collected = new Set<string>([rootId])
  const queue: string[] = [rootId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const childId of childrenByParent.get(current) ?? []) {
      if (collected.has(childId)) continue
      collected.add(childId)
      queue.push(childId)
    }
  }
  return [...collected]
}

/**
 * Human-readable path ("Parent / Child") for every folder, keyed by id.
 * A cycle or a dangling parent id ends the walk instead of looping.
 */
export function folderPaths(all: Array<FolderRef & { name: string }>): Map<string, string> {
  const byId = new Map(all.map((f) => [f.id, f]))
  const paths = new Map<string, string>()
  for (const folder of all) {
    const names: string[] = []
    const seen = new Set<string>()
    let current: (FolderRef & { name: string }) | undefined = folder
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      names.unshift(current.name)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    paths.set(folder.id, names.join(' / '))
  }
  return paths
}

export async function listTenantFolders(db: Db, tenantId: string) {
  return db.select().from(folders).where(eq(folders.tenantId, tenantId)).orderBy(folders.name)
}

/** Number of images directly in each folder (key null = images without a folder). */
export async function directImageCounts(db: Db, tenantId: string): Promise<Map<string | null, number>> {
  const rows = await db
    .select({ folderId: images.folderId, count: sql<number>`count(*)::int` })
    .from(images)
    .where(eq(images.tenantId, tenantId))
    .groupBy(images.folderId)
  return new Map(rows.map((r) => [r.folderId, Number(r.count)]))
}
