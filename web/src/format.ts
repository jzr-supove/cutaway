export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** "1:02:03.450" or "02:03.450" — always with milliseconds, for frame-level work. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const whole = Math.floor(seconds)
  const ms = Math.round((seconds - whole) * 1000)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const head = h > 0 ? `${h}:${pad(m)}` : pad(m)
  return `${head}:${pad(s)}.${pad(ms, 3)}`
}

/** Compact form without milliseconds, for durations and labels. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Accepts "12", "1:23", "1:23.4", "1:02:03.450". Returns null when unparseable,
 * so a half-typed value does not clobber the current point.
 */
export function parseTimecode(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(trimmed)) return null

  const [clock = '', fraction] = trimmed.split('.')
  const parts = clock.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null

  let total = 0
  for (const part of parts) total = total * 60 + part
  if (fraction) total += Number(`0.${fraction}`)
  return Number.isFinite(total) ? total : null
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
