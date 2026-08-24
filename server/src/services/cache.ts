import fs from 'node:fs/promises'
import path from 'node:path'
import { CACHE_DIR, CACHE_MAX_BYTES } from '../config.ts'

/** Stable, filesystem-safe identity for a downloaded source. */
export function cacheKey(extractor: string, id: string, maxHeight: number): string {
  const slug = `${extractor}-${id}-${maxHeight}p`
  return slug.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

/** Existing cached file for a key, or null. Touches it so LRU sees the access. */
export async function findCached(key: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await fs.readdir(CACHE_DIR)
  } catch {
    return null
  }
  // Ignore yt-dlp's in-progress artifacts (.part, .ytdl, .f137.mp4 fragments).
  const match = entries.find((name) => {
    if (!name.startsWith(`${key}.`)) return false
    const ext = path.extname(name).toLowerCase()
    return ext === '.mp4' || ext === '.mkv' || ext === '.webm'
  })
  if (!match) return null

  const full = path.join(CACHE_DIR, match)
  try {
    const stat = await fs.stat(full)
    if (!stat.isFile() || stat.size === 0) return null
    const now = new Date()
    await fs.utimes(full, now, now)
  } catch {
    return null
  }
  return match
}

/**
 * Evict least-recently-used sources until the cache fits under the cap.
 * Derived artifacts (filmstrips) are removed alongside their source.
 */
export async function enforceCacheLimit(): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(CACHE_DIR)
  } catch {
    return
  }

  const files = (
    await Promise.all(
      names.map(async (name) => {
        try {
          const stat = await fs.stat(path.join(CACHE_DIR, name))
          return stat.isFile() ? { name, size: stat.size, mtime: stat.mtimeMs } : null
        } catch {
          return null
        }
      }),
    )
  ).filter((f): f is { name: string; size: number; mtime: number } => f !== null)

  let total = files.reduce((sum, f) => sum + f.size, 0)
  if (total <= CACHE_MAX_BYTES) return

  const videos = files
    .filter((f) => /\.(mp4|mkv|webm)$/i.test(f.name))
    .sort((a, b) => a.mtime - b.mtime)

  for (const video of videos) {
    if (total <= CACHE_MAX_BYTES) break
    const stem = video.name.slice(0, video.name.lastIndexOf('.'))
    for (const f of files) {
      if (f.name !== video.name && !f.name.startsWith(`${stem}.`)) continue
      try {
        await fs.rm(path.join(CACHE_DIR, f.name), { force: true })
        total -= f.size
      } catch {
        /* file is in use; skip it and try the next candidate */
      }
    }
  }
}
