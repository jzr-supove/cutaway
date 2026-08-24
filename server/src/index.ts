import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { CACHE_DIR, HOST, PORT, ROOT, ensureDirs } from './config.ts'
import { registerApi } from './routes/api.ts'
import { probeNvenc } from './services/ffmpeg.ts'
import { enforceCacheLimit } from './services/cache.ts'

const app = Fastify({
  logger: { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
  // Long merges and slow sources should not be cut off by a request timeout.
  requestTimeout: 0,
  connectionTimeout: 0,
})

ensureDirs()

/**
 * Serving the cached source through @fastify/static gives correct HTTP Range
 * handling (206 + Content-Range), which is what makes timeline scrubbing feel
 * instant instead of re-fetching the file on every seek.
 */
await app.register(fastifyStatic, {
  root: CACHE_DIR,
  prefix: '/api/media/',
  index: false,
  acceptRanges: true,
  cacheControl: true,
  maxAge: '1h',
  // The <video> element only ever needs these.
  extensions: [],
})

await registerApi(app)

// Production: serve the built frontend. In dev, Vite serves it and proxies /api.
const webDist = path.join(ROOT, 'web', 'dist')
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    decorateReply: false,
    index: ['index.html'],
  })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found.' })
    }
    return reply.sendFile('index.html')
  })
}

const nvenc = await probeNvenc()
app.log.info(
  nvenc
    ? 'GPU encoder available (h264_nvenc) — precise exports will use it.'
    : 'No GPU encoder detected — precise exports will use libx264 on the CPU.',
)

void enforceCacheLimit().catch(() => {})

try {
  // 127.0.0.1 only: this tool has no auth and must not be reachable from the LAN.
  await app.listen({ host: HOST, port: PORT })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
