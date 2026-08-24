import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { CACHE_DIR, EXPORT_DIR } from '../config.ts'
import { jobs } from '../services/jobs.ts'
import { validateSourceUrl, InvalidUrlError } from '../services/url.ts'
import { resolveMeta } from '../services/ytdlp.ts'
import { clampHeight, rememberMeta, startDownload } from '../services/downloads.ts'
import {
  buildFilmstrip,
  ffmpegExporter,
  probeDuration,
  probeKeyframes,
  probeNvenc,
  safeFilename,
} from '../services/ffmpeg.ts'
import type { ExportMode, ExportResult } from '../types.ts'

const ALLOWED_BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium', 'safari']

function readBrowser(value: unknown): string | null {
  return typeof value === 'string' && ALLOWED_BROWSERS.includes(value) ? value : null
}

/**
 * Resolves a client-supplied filename against a directory, refusing anything that
 * escapes it. Guards the media, filmstrip and export routes against traversal.
 */
async function resolveInside(dir: string, name: unknown): Promise<string> {
  // Fastify has already percent-decoded the route parameter; decoding again here
  // would let a double-encoded "%252e%252e" slip through as "..".
  if (typeof name !== 'string' || name.length === 0) throw new HttpError(400, 'Missing file name.')
  const base = path.basename(name)
  if (base !== name || base === '.' || base === '..') {
    throw new HttpError(400, 'Invalid file name.')
  }
  const full = path.join(dir, base)
  if (path.relative(dir, full) !== base) throw new HttpError(400, 'Invalid file name.')
  try {
    const stat = await fs.stat(full)
    if (!stat.isFile()) throw new HttpError(404, 'Not found.')
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(404, 'That file is no longer in the cache. Load the video again.')
  }
  return full
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Concurrent requests for the same strip share one ffmpeg run. */
const filmstripJobs = new Map<string, Promise<string>>()

/** Keyframe lists never change for a given cached file, so probe each once. */
const keyframeCache = new Map<string, Promise<number[]>>()

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    nvenc: await probeNvenc(),
  }))

  app.post('/api/resolve', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const url = validateSourceUrl(body.url)
    const meta = await resolveMeta(url, { cookiesFromBrowser: readBrowser(body.cookiesFromBrowser) })
    rememberMeta(url, meta)
    return { url, meta }
  })

  app.post('/api/download', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const url = validateSourceUrl(body.url)
    const jobId = startDownload({
      url,
      maxHeight: clampHeight(body.maxHeight),
      cookiesFromBrowser: readBrowser(body.cookiesFromBrowser),
    })
    return { jobId }
  })

  app.get('/api/jobs/:id', async (request) => {
    const { id } = request.params as { id: string }
    const state = jobs.get(id)
    if (!state) throw new HttpError(404, 'Unknown job.')
    return state
  })

  app.get('/api/jobs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string }
    if (!jobs.get(id)) {
      void reply.code(404).send({ error: 'Unknown job.' })
      return
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const unsubscribe = jobs.subscribe(id, (state) => {
      reply.raw.write(`data: ${JSON.stringify(state)}\n\n`)
      if (state.status !== 'running') {
        unsubscribe()
        reply.raw.end()
      }
    })

    // Keeps proxies from closing an idle connection during a long merge.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
    reply.raw.on('close', () => clearInterval(heartbeat))
  })

  app.get('/api/filmstrip/:file', async (request, reply) => {
    const { file } = request.params as { file: string }
    const source = await resolveInside(CACHE_DIR, file)
    const stem = source.slice(0, source.lastIndexOf('.'))
    const stripPath = `${stem}.strip.jpg`

    const exists = await fs
      .stat(stripPath)
      .then((s) => s.isFile() && s.size > 0)
      .catch(() => false)

    if (!exists) {
      let pending = filmstripJobs.get(stripPath)
      if (!pending) {
        pending = (async () => {
          const duration = await probeDuration(source)
          await buildFilmstrip(source, stripPath, duration)
          return stripPath
        })().finally(() => filmstripJobs.delete(stripPath))
        filmstripJobs.set(stripPath, pending)
      }
      try {
        await pending
      } catch {
        throw new HttpError(422, 'Could not build the timeline preview for this video.')
      }
    }

    const data = await fs.readFile(stripPath)
    return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=86400').send(data)
  })

  app.get('/api/keyframes/:file', async (request) => {
    const { file } = request.params as { file: string }
    const source = await resolveInside(CACHE_DIR, file)

    let cached = keyframeCache.get(source)
    if (!cached) {
      cached = probeKeyframes(source).catch((err) => {
        keyframeCache.delete(source)
        throw err
      })
      keyframeCache.set(source, cached)
    }
    return { times: await cached }
  })

  app.post('/api/export', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const source = await resolveInside(CACHE_DIR, body.file)

    const start = Number(body.start)
    const end = Number(body.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new HttpError(400, 'Set a valid start and end point.')
    }
    if (end - start < 0.02) throw new HttpError(400, 'The selection is too short to export.')

    const mode: ExportMode = body.mode === 'instant' ? 'instant' : 'precise'
    const title = typeof body.title === 'string' ? body.title : 'clip'
    const outName = await uniqueExportName(title, start, end)
    const outPath = path.join(EXPORT_DIR, outName)

    const job = jobs.create('export', mode === 'instant' ? 'Copying stream' : 'Encoding clip')

    void (async () => {
      try {
        await ffmpegExporter.cut({ source, start, end, mode, outPath }, (p) => {
          jobs.update(job.id, { phase: p.phase, percent: p.percent })
        })
        const [stat, duration] = await Promise.all([fs.stat(outPath), probeDuration(outPath)])
        const result: ExportResult = {
          file: outName,
          downloadUrl: `/api/clips/${encodeURIComponent(outName)}`,
          bytes: stat.size,
          duration,
        }
        jobs.succeed(job.id, result)
      } catch (err) {
        await fs.rm(outPath, { force: true }).catch(() => {})
        jobs.fail(job.id, err instanceof Error ? err.message : String(err))
      }
    })()

    return { jobId: job.id }
  })

  app.get('/api/clips/:file', async (request, reply) => {
    const { file } = request.params as { file: string }
    const full = await resolveInside(EXPORT_DIR, file)
    const name = path.basename(full)
    const data = await fs.readFile(full)
    return reply
      .type('video/mp4')
      .header(
        'Content-Disposition',
        `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(data)
  })

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply: FastifyReply) => {
    const status =
      error instanceof HttpError
        ? error.statusCode
        : error instanceof InvalidUrlError
          ? 400
          : (error.statusCode ?? 500)
    void reply.code(status).send({ error: error.message || 'Something went wrong.' })
  })
}

async function uniqueExportName(title: string, start: number, end: number): Promise<string> {
  const stamp = `${formatClock(start)}-${formatClock(end)}`
  const base = `${safeFilename(title, 'clip')} ${stamp}`
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt === 0 ? `${base}.mp4` : `${base} (${attempt}).mp4`
    const taken = await fs
      .stat(path.join(EXPORT_DIR, name))
      .then(() => true)
      .catch(() => false)
    if (!taken) return name
  }
  return `${base} ${Date.now()}.mp4`
}

function formatClock(seconds: number): string {
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ms = Math.round((seconds - total) * 1000)
  const hh = h > 0 ? `${h}h` : ''
  return `${hh}${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s${String(ms).padStart(3, '0')}`
}
