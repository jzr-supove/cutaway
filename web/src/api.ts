import type { Settings, VideoMeta } from './types.ts'

export class ApiError extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Cannot reach the local server. Is it still running?')
  }

  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  if (!response.ok) {
    throw new ApiError(payload?.error ?? `Request failed (${response.status}).`)
  }
  return payload as T
}

export function resolveVideo(url: string, settings: Settings) {
  return post<{ url: string; meta: VideoMeta }>('/api/resolve', {
    url,
    cookiesFromBrowser: settings.cookiesFromBrowser,
  })
}

export function startDownload(url: string, settings: Settings) {
  return post<{ jobId: string }>('/api/download', {
    url,
    maxHeight: settings.maxHeight,
    cookiesFromBrowser: settings.cookiesFromBrowser,
  })
}

export async function fetchKeyframes(file: string): Promise<number[]> {
  const response = await fetch(`/api/keyframes/${encodeURIComponent(file)}`)
  if (!response.ok) return []
  const payload = (await response.json()) as { times?: number[] }
  return Array.isArray(payload.times) ? payload.times : []
}

export function startExport(input: {
  file: string
  start: number
  end: number
  mode: string
  title: string
}) {
  return post<{ jobId: string }>('/api/export', input)
}
