import path from 'node:path'
import fs from 'node:fs'

/** server/src -> repo root */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')

export const CACHE_DIR = process.env.CLIP_CACHE_DIR ?? path.join(ROOT, 'cache')
export const EXPORT_DIR = process.env.CLIP_EXPORT_DIR ?? path.join(ROOT, 'exports')

export const YTDLP_BIN = process.env.YTDLP_BIN ?? 'yt-dlp'
export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg'
export const FFPROBE_BIN = process.env.FFPROBE_BIN ?? 'ffprobe'

export const HOST = '127.0.0.1'
export const PORT = Number(process.env.PORT ?? 3001)

/** Max bytes kept in cache/ before least-recently-used sources are evicted. */
export const CACHE_MAX_BYTES = Number(process.env.CLIP_CACHE_MAX_BYTES ?? 20 * 1024 ** 3)

/** Default vertical resolution cap for downloads. */
export const DEFAULT_MAX_HEIGHT = Number(process.env.CLIP_MAX_HEIGHT ?? 1080)

/** Number of frames in the timeline filmstrip. */
export const FILMSTRIP_FRAMES = 60
export const FILMSTRIP_HEIGHT = 64

export function ensureDirs(): void {
  for (const dir of [CACHE_DIR, EXPORT_DIR]) fs.mkdirSync(dir, { recursive: true })
}
