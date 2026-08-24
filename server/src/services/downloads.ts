import path from 'node:path'
import { CACHE_DIR, DEFAULT_MAX_HEIGHT } from '../config.ts'
import type { DownloadResult, VideoMeta } from '../types.ts'
import { jobs } from './jobs.ts'
import { cacheKey, enforceCacheLimit, findCached } from './cache.ts'
import { download, resolveMeta } from './ytdlp.ts'
import { ensureFastStart } from './ffmpeg.ts'

export interface StartOptions {
  url: string
  maxHeight?: number
  cookiesFromBrowser?: string | null
}

/** Short-lived metadata cache so /resolve then /download does not probe twice. */
const META_TTL_MS = 5 * 60 * 1000
const metaCache = new Map<string, { meta: VideoMeta; at: number }>()

export function rememberMeta(url: string, meta: VideoMeta): void {
  metaCache.set(url, { meta, at: Date.now() })
  if (metaCache.size > 100) {
    for (const [k, v] of metaCache) if (Date.now() - v.at > META_TTL_MS) metaCache.delete(k)
  }
}

function recallMeta(url: string): VideoMeta | null {
  const hit = metaCache.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > META_TTL_MS) {
    metaCache.delete(url)
    return null
  }
  return hit.meta
}

/** cacheKey -> jobId, so two tabs asking for the same video share one download. */
const inFlight = new Map<string, string>()

export function startDownload(opts: StartOptions): string {
  const maxHeight = clampHeight(opts.maxHeight)
  const job = jobs.create('download', 'Reading video info')

  void (async () => {
    let key: string | null = null
    try {
      const meta = recallMeta(opts.url) ?? (await resolveMeta(opts.url, opts))
      rememberMeta(opts.url, meta)

      key = cacheKey(meta.extractor, meta.id, maxHeight)

      const existingJobId = inFlight.get(key)
      if (existingJobId && jobs.get(existingJobId)?.status === 'running') {
        // Mirror the in-progress job rather than downloading the same file twice.
        jobs.update(job.id, { phase: 'Joining an in-progress download' })
        const unsubscribe = jobs.subscribe(existingJobId, (state) => {
          jobs.update(job.id, {
            status: state.status,
            phase: state.phase,
            percent: state.percent,
            speed: state.speed,
            eta: state.eta,
            result: state.result,
            error: state.error,
          })
          if (state.status !== 'running') unsubscribe()
        })
        return
      }
      inFlight.set(key, job.id)

      const cached = await findCached(key)
      if (cached) {
        jobs.succeed(job.id, buildResult(cached, meta, true))
        return
      }

      jobs.update(job.id, { phase: 'Downloading video', percent: 0 })
      await download(opts.url, key, { maxHeight, cookiesFromBrowser: opts.cookiesFromBrowser }, (p) => {
        jobs.update(job.id, { phase: p.phase, percent: p.percent, speed: p.speed, eta: p.eta })
      })

      const file = await findCached(key)
      if (!file) throw new Error('The download finished but no video file was produced.')

      jobs.update(job.id, { phase: 'Preparing for seeking', percent: null, speed: null, eta: null })
      await ensureFastStart(path.join(CACHE_DIR, file))

      void enforceCacheLimit().catch(() => {})
      jobs.succeed(job.id, buildResult(file, meta, false))
    } catch (err) {
      jobs.fail(job.id, err instanceof Error ? err.message : String(err))
    } finally {
      if (key && inFlight.get(key) === job.id) inFlight.delete(key)
    }
  })()

  return job.id
}

function buildResult(file: string, meta: VideoMeta, cached: boolean): DownloadResult {
  const encoded = encodeURIComponent(file)
  return {
    file,
    mediaUrl: `/api/media/${encoded}`,
    filmstripUrl: `/api/filmstrip/${encoded}`,
    meta,
    cached,
  }
}

export function clampHeight(value: unknown): number {
  const allowed = [360, 480, 720, 1080, 1440, 2160]
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_MAX_HEIGHT
  return allowed.reduce((best, h) => (Math.abs(h - n) < Math.abs(best - n) ? h : best), DEFAULT_MAX_HEIGHT)
}
