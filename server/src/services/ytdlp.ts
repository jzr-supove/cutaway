import path from 'node:path'
import { CACHE_DIR, YTDLP_BIN } from '../config.ts'
import { run, ProcError } from './proc.ts'
import type { VideoMeta } from '../types.ts'

export interface DownloadOptions {
  maxHeight: number
  /** Read cookies from this installed browser, for private/age-gated content. */
  cookiesFromBrowser?: string | null
  signal?: AbortSignal
}

export interface Progress {
  phase: string
  percent: number | null
  speed: string | null
  eta: string | null
}

/**
 * "--" terminates option parsing so a URL can never be read as a flag, even if
 * validateSourceUrl were bypassed.
 */
const END_OF_OPTIONS = '--'

const COMMON_ARGS = [
  '--no-playlist',
  '--no-warnings',
  '--ignore-config',
  // Instagram's web API answers /media/<id>/info/ with an empty body, and the
  // extractor re-raises the resulting JSON parse error instead of falling back
  // to its logged-out path — so a reel fails outright, and fails *harder* with
  // cookies enabled, because being logged in is what selects that path.
  // app_id=ios routes to i.instagram.com, which answers normally either way.
  // extractor-args are namespaced, so no other site sees this.
  '--extractor-args',
  'instagram:app_id=ios',
]

export async function resolveMeta(url: string, opts: { cookiesFromBrowser?: string | null } = {}): Promise<VideoMeta> {
  const args = [
    ...COMMON_ARGS,
    '--dump-single-json',
    '--skip-download',
    ...cookieArgs(opts.cookiesFromBrowser),
    END_OF_OPTIONS,
    url,
  ]

  let stdout: string
  try {
    ;({ stdout } = await run(YTDLP_BIN, args))
  } catch (err) {
    throw translateYtdlpError(err)
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error('yt-dlp returned output that could not be parsed. Try updating it: yt-dlp -U')
  }

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  return {
    id: String(raw.id ?? 'unknown'),
    extractor: String(raw.extractor_key ?? raw.extractor ?? 'generic'),
    title: String(raw.title ?? 'Untitled'),
    duration: num(raw.duration) ?? 0,
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : null,
    fps: num(raw.fps) ?? 30,
    width: num(raw.width),
    height: num(raw.height),
    uploader: typeof raw.uploader === 'string' ? raw.uploader : null,
    webpageUrl: typeof raw.webpage_url === 'string' ? raw.webpage_url : url,
  }
}

/** Downloads to cache/<key>.<ext> and returns the produced filename. */
export async function download(
  url: string,
  key: string,
  opts: DownloadOptions,
  onProgress: (p: Progress) => void,
): Promise<void> {
  const { maxHeight } = opts

  const args = [
    ...COMMON_ARGS,
    '--newline',
    '--no-mtime', // keep mtime = download time so LRU eviction is meaningful
    '--concurrent-fragments',
    '4',
    '--retries',
    '5',
    '--fragment-retries',
    '10',
    '--extractor-retries',
    '3',
    '-f',
    `bv*[height<=?${maxHeight}]+ba/b[height<=?${maxHeight}]/b`,
    // Highest allowed resolution first, then prefer codecs the <video> tag and a
    // stream-copy export both handle without complaint.
    '-S',
    'res,vcodec:h264,acodec:aac,ext:mp4:m4a',
    '--merge-output-format',
    'mp4',
    // moov atom at the front of the file, or browser seeking is unusable.
    '--postprocessor-args',
    'Merger:-movflags +faststart',
    '--postprocessor-args',
    'VideoRemuxer:-movflags +faststart',
    '-o',
    path.join(CACHE_DIR, `${key}.%(ext)s`),
    // A machine-readable progress line is stable across yt-dlp releases; the
    // human-readable output is not.
    '--progress-template',
    'download:CCPROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.vcodec)s',
    ...cookieArgs(opts.cookiesFromBrowser),
    END_OF_OPTIONS,
    url,
  ]

  const handleLine = (line: string) => {
    if (line.startsWith('CCPROG|')) {
      const p = parseProgressLine(line)
      if (p) onProgress(p)
      return
    }
    if (line.includes('[Merger]')) {
      onProgress({ phase: 'Merging video and audio', percent: null, speed: null, eta: null })
    } else if (line.includes('[VideoRemuxer]')) {
      onProgress({ phase: 'Remuxing to MP4', percent: null, speed: null, eta: null })
    } else if (line.includes('[FixupM3u8]') || line.includes('[Fixup')) {
      onProgress({ phase: 'Fixing up stream', percent: null, speed: null, eta: null })
    }
  }

  // YouTube intermittently answers 403 with URLs that were valid moments earlier.
  // Re-running the extractor mints fresh ones, so one silent retry turns a common
  // hard failure into a brief pause.
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      await run(YTDLP_BIN, args, { onLine: handleLine, signal: opts.signal, captureStdout: false })
      return
    } catch (err) {
      const transient =
        err instanceof ProcError && err.code > 0 && TRANSIENT_FAILURE.test(err.stderr)
      if (!transient || attempt === 1) throw translateYtdlpError(err)
      onProgress({
        phase: 'The site refused the first attempt — retrying',
        percent: null,
        speed: null,
        eta: null,
      })
    }
  }
}

const TRANSIENT_FAILURE =
  /http error 40[39]|unable to download|connection reset|timed out|temporary failure|read error|incomplete/i

function parseProgressLine(line: string): Progress | null {
  const [, status, downloadedRaw, totalRaw, speedRaw, etaRaw, vcodec] = line.split('|')
  if (status !== 'downloading' && status !== 'finished') return null

  const downloaded = toNumber(downloadedRaw)
  const total = toNumber(totalRaw)
  const percent =
    status === 'finished' ? 100 : downloaded !== null && total ? (downloaded / total) * 100 : null

  // vcodec "none" means this is the audio-only stream of a DASH pair.
  const isAudio = vcodec === 'none'
  const phase = isAudio ? 'Downloading audio' : 'Downloading video'

  return {
    phase,
    percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
    speed: formatSpeed(toNumber(speedRaw)),
    eta: formatEta(toNumber(etaRaw)),
  }
}

function toNumber(raw: string | undefined): number | null {
  if (!raw || raw === 'NA') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function formatSpeed(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return null
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatEta(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function cookieArgs(browser: string | null | undefined): string[] {
  if (!browser) return []
  // Restricted to a known list so this can never inject an arbitrary yt-dlp value.
  const allowed = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium', 'safari']
  if (!allowed.includes(browser)) return []
  return ['--cookies-from-browser', browser]
}

/** Turn yt-dlp's stderr into something a person can act on. */
function translateYtdlpError(err: unknown): Error {
  if (!(err instanceof ProcError)) return err instanceof Error ? err : new Error(String(err))
  if (err.code === -1) return err // spawn failure; message is already actionable

  const stderr = err.stderr
  const rules: Array<[RegExp, string]> = [
    [
      /sign in to confirm(?:.*)(?:bot|not a bot)/i,
      'YouTube is asking this request to prove it is not a bot. Turn on "Use browser cookies" in settings and pick the browser you are signed into.',
    ],
    [
      /private video|this video is private/i,
      'That video is private. If you have access, turn on "Use browser cookies" and pick the browser you are signed into.',
    ],
    [
      /members-only|join this channel/i,
      'That video is members-only. Turn on "Use browser cookies" with an account that has access.',
    ],
    [
      /video unavailable|has been removed|no longer available|removed by the uploader/i,
      'That video is unavailable or has been removed.',
    ],
    [
      /not available in your country|geo.?restrict|blocked it in your country/i,
      'That video is geo-blocked in your region.',
    ],
    [
      /age.?restrict|confirm your age|inappropriate for some users/i,
      'That video is age-restricted. Turn on "Use browser cookies" with a signed-in account.',
    ],
    [
      /login required|requested format is not available.*login|you need to log in|use --cookies/i,
      'That link needs a logged-in session. Turn on "Use browser cookies" and pick the browser you are signed into.',
    ],
    [
      /unsupported url|no video formats found|unable to extract/i,
      'yt-dlp could not find a video at that link. It may be unsupported, or yt-dlp may need updating (run: yt-dlp -U).',
    ],
    [
      /failed to parse json|expecting value/i,
      'The site returned an unreadable response, which usually means its extractor has broken. Updating yt-dlp normally fixes it: yt-dlp -U',
    ],
    [
      /could not copy .*cookie database|permission denied.*cookies|unable to (?:open|read) cookie/i,
      'Could not read cookies from that browser. Close the browser completely and try again.',
    ],
    [
      /http error 429|too many requests/i,
      'The site is rate-limiting this connection. Wait a few minutes and try again.',
    ],
    [/http error 403|forbidden/i, 'The site refused the download (HTTP 403). Updating yt-dlp often fixes this: yt-dlp -U'],
    [/unable to download|network|timed out|connection reset/i, 'Network error while contacting the site. Check your connection and try again.'],
  ]

  for (const [pattern, message] of rules) {
    if (pattern.test(stderr)) return new Error(message)
  }

  const lastError = stderr
    .split(/\r?\n/)
    .reverse()
    .find((l) => /^ERROR:/i.test(l.trim()))
  return new Error(lastError?.replace(/^ERROR:\s*/i, '').trim() || 'yt-dlp failed to download this video.')
}
