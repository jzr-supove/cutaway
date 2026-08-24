export interface VideoMeta {
  id: string
  extractor: string
  title: string
  duration: number
  thumbnail: string | null
  fps: number
  width: number | null
  height: number | null
  uploader: string | null
  webpageUrl: string
}

export type JobStatus = 'running' | 'done' | 'error'

export interface JobState<R = unknown> {
  id: string
  kind: 'download' | 'export'
  status: JobStatus
  phase: string
  percent: number | null
  speed: string | null
  eta: string | null
  result: R | null
  error: string | null
}

export interface DownloadResult {
  file: string
  mediaUrl: string
  filmstripUrl: string
  meta: VideoMeta
  cached: boolean
}

export interface ExportResult {
  file: string
  downloadUrl: string
  bytes: number
  duration: number
}

export type ExportMode = 'precise' | 'instant'

export interface Settings {
  maxHeight: number
  cookiesFromBrowser: string | null
}
