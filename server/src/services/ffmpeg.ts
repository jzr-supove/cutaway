import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { FFMPEG_BIN, FFPROBE_BIN, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT } from '../config.ts'
import { run, ProcError } from './proc.ts'
import type { ExportMode } from '../types.ts'

export interface CutRequest {
  source: string
  start: number
  end: number
  mode: ExportMode
  outPath: string
}

export interface CutProgress {
  percent: number | null
  phase: string
}

/**
 * The seam that keeps a future browser-side (WebCodecs) implementation a drop-in:
 * routes depend on this interface, not on ffmpeg.
 */
export interface ClipExporter {
  readonly name: string
  cut(req: CutRequest, onProgress: (p: CutProgress) => void, signal?: AbortSignal): Promise<void>
}

let nvencAvailable: boolean | null = null

/** Probed once at startup; the result is reused for every export. */
export async function probeNvenc(): Promise<boolean> {
  if (nvencAvailable !== null) return nvencAvailable
  try {
    await run(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=320x240:r=30:d=0.2',
      '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ])
    nvencAvailable = true
  } catch {
    nvencAvailable = false
  }
  return nvencAvailable
}

export const ffmpegExporter: ClipExporter = {
  name: 'ffmpeg',

  async cut(req, onProgress, signal) {
    const duration = req.end - req.start
    if (!(duration > 0)) throw new Error('The end point must come after the start point.')

    const args =
      req.mode === 'instant' ? await instantArgs(req, duration) : await preciseArgs(req, duration)

    onProgress({
      percent: req.mode === 'instant' ? null : 0,
      phase: req.mode === 'instant' ? 'Copying stream' : 'Encoding clip',
    })

    const handleLine = (line: string) => {
      // ffmpeg -progress emits key=value lines; out_time_us is relative to the
      // output timeline, which starts at zero because -ss precedes -i.
      const match = /^out_time_us=(-?\d+)$/.exec(line.trim())
      if (!match?.[1]) return
      const seconds = Number(match[1]) / 1_000_000
      if (!Number.isFinite(seconds) || seconds < 0) return
      onProgress({
        percent: Math.min(99, (seconds / duration) * 100),
        phase: req.mode === 'instant' ? 'Copying stream' : 'Encoding clip',
      })
    }

    try {
      await run(FFMPEG_BIN, args, { onLine: handleLine, signal, captureStdout: false })
    } catch (err) {
      throw translateFfmpegError(err, req.mode)
    }
  },
}

/**
 * -ss BEFORE -i is both accurate and fast in ffmpeg 5+: it seeks to the preceding
 * keyframe, then decodes forward and discards frames until the exact start time.
 * -t (not -to) because output timestamps are rebased to zero by the input seek.
 */
async function preciseArgs(req: CutRequest, duration: number): Promise<string[]> {
  const useNvenc = await probeNvenc()
  const videoCodec = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '20', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', req.start.toFixed(6),
    '-i', req.source,
    '-t', duration.toFixed(6),
    '-map', '0:v:0', '-map', '0:a:0?',
    ...videoCodec,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    req.outPath,
  ]
}

/**
 * Lossless, but the cut snaps to the nearest preceding keyframe.
 * -avoid_negative_ts make_zero prevents the leading black frames and desynced
 * audio that a naive copy cut produces.
 */
async function instantArgs(req: CutRequest, duration: number): Promise<string[]> {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', req.start.toFixed(6),
    '-i', req.source,
    '-t', duration.toFixed(6),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    req.outPath,
  ]
}

export async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await run(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ])
    const value = Number(stdout.trim())
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/**
 * Timestamps of every keyframe in the video stream.
 *
 * Instant (stream-copy) exports can only start on a keyframe, so the UI needs
 * these to show where a cut will really land. Reading packet flags avoids
 * decoding, which keeps this fast even on hour-long sources.
 */
export async function probeKeyframes(file: string): Promise<number[]> {
  const { stdout } = await run(FFPROBE_BIN, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    file,
  ])

  const times: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const [pts, flags] = line.split(',')
    if (!flags?.includes('K')) continue
    const time = Number(pts)
    if (Number.isFinite(time)) times.push(time)
  }
  times.sort((a, b) => a - b)
  return times
}

/**
 * Builds a single horizontal strip of thumbnails for the timeline.
 * -skip_frame nokey decodes keyframes only, which keeps this fast on long videos
 * at the cost of slightly uneven sampling — fine for a scrubbing aid.
 */
export async function buildFilmstrip(source: string, outPath: string, duration: number): Promise<void> {
  const rate = FILMSTRIP_FRAMES / Math.max(duration, 1)
  await run(FFMPEG_BIN, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-skip_frame', 'nokey',
    '-i', source,
    '-an', '-sn',
    '-vf', `fps=${rate.toFixed(6)},scale=-2:${FILMSTRIP_HEIGHT},tile=${FILMSTRIP_FRAMES}x1`,
    '-frames:v', '1',
    '-q:v', '4',
    outPath,
  ])
}

/**
 * Guarantees the moov atom sits at the front of the file.
 *
 * yt-dlp applies +faststart during merge and remux, but a source served as a
 * single already-muxed MP4 skips both post-processors. Without moov-first the
 * browser cannot seek until the whole file has downloaded, which would break the
 * one interaction this app exists for.
 */
export async function ensureFastStart(file: string): Promise<boolean> {
  if (!/\.(mp4|m4v|mov)$/i.test(file)) return false
  if (!(await needsFastStart(file))) return false

  const repaired = `${file}.faststart.mp4`
  try {
    await run(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', file,
      '-c', 'copy', '-map', '0',
      '-movflags', '+faststart',
      repaired,
    ])
    await fs.rm(file, { force: true })
    await fs.rename(repaired, file)
    return true
  } catch {
    await fs.rm(repaired, { force: true }).catch(() => {})
    return false
  }
}

/** Walks top-level MP4 boxes; true when mdat is reached before moov. */
async function needsFastStart(file: string): Promise<boolean> {
  let handle: FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const header = Buffer.alloc(16)
    let offset = 0

    for (let box = 0; box < 32; box++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) return false

      let size = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      let headerSize = 8

      if (size === 1) {
        if (bytesRead < 16) return false
        const large = header.readBigUInt64BE(8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false
        size = Number(large)
        headerSize = 16
      } else if (size === 0) {
        return false // extends to EOF; nothing meaningful follows
      }
      if (size < headerSize) return false

      if (type === 'moov') return false
      if (type === 'mdat') return true
      offset += size
    }
    return false
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

function translateFfmpegError(err: unknown, mode: ExportMode): Error {
  if (!(err instanceof ProcError)) return err instanceof Error ? err : new Error(String(err))
  if (err.code === -1) return err

  const stderr = err.stderr
  if (/No space left on device/i.test(stderr)) {
    return new Error('Ran out of disk space while writing the clip.')
  }
  if (mode === 'instant' && /(Invalid data|could not find codec|non-monotonous|muxer does not support)/i.test(stderr)) {
    return new Error(
      'This video cannot be cut losslessly into MP4. Switch to Precise mode, which re-encodes.',
    )
  }
  if (/nvenc|cuda|no capable devices/i.test(stderr)) {
    nvencAvailable = false // fall back to libx264 on the next attempt
    return new Error('The GPU encoder failed. Try the export again — it will use the CPU encoder.')
  }
  const detail = stderr.split(/\r?\n/).filter(Boolean).pop()
  return new Error(detail ? `ffmpeg failed: ${detail}` : 'ffmpeg failed to produce the clip.')
}

/** Filesystem-safe filename derived from a video title. */
export function safeFilename(title: string, fallback: string): string {
  const cleaned = title
    .normalize('NFKD')
    // Strip control characters and everything Windows/POSIX forbid in a filename.
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  return cleaned || fallback
}
