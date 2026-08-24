export interface VideoMeta {
  id: string
  extractor: string
  title: string
  /** Seconds. 0 when the source does not report one (rare; live/streamed). */
  duration: number
  thumbnail: string | null
  fps: number
  width: number | null
  height: number | null
  uploader: string | null
  webpageUrl: string
}

export type JobKind = 'download' | 'export'
export type JobStatus = 'running' | 'done' | 'error'

export interface JobState<R = unknown> {
  id: string
  kind: JobKind
  status: JobStatus
  /** Human-readable stage, e.g. "Downloading video", "Merging", "Encoding". */
  phase: string
  /** 0..100, or null when the stage has no measurable progress. */
  percent: number | null
  speed: string | null
  eta: string | null
  result: R | null
  error: string | null
}

export interface DownloadResult {
  /** Filename inside cache/, served at /api/media/<file>. */
  file: string
  mediaUrl: string
  filmstripUrl: string
  meta: VideoMeta
  /** Whether the source was already cached (no network fetch happened). */
  cached: boolean
}

export interface ExportResult {
  file: string
  downloadUrl: string
  bytes: number
  /** Measured duration of the produced clip, from ffprobe. */
  duration: number
}

export type ExportMode = 'precise' | 'instant'
