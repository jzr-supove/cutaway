/**
 * The URL is untrusted input that gets handed to yt-dlp. Two things to defend:
 *
 *  1. Argument injection. A string like "--exec=calc.exe" would be read by yt-dlp
 *     as a flag, not a URL. Requiring an http(s) scheme rules that out, and callers
 *     additionally pass "--" before the positional argument.
 *  2. SSRF. Without a check, this becomes an open relay onto the loopback interface
 *     and the local network.
 *
 * Shell metacharacters are a non-issue: every spawn uses an argument array with
 * shell:false, so ";", "&", "|" and friends are never interpreted.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
])

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (host === '::' || host === '::1') return true
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (mapped?.[1]) return isPrivateAddress(mapped[1])
  // Unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  return false
}

export class InvalidUrlError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'InvalidUrlError'
  }
}

/** Returns the normalized URL, or throws InvalidUrlError. */
export function validateSourceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new InvalidUrlError('Paste a video link first.')
  }
  const trimmed = raw.trim()

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new InvalidUrlError(`"${trimmed.slice(0, 80)}" is not a valid URL.`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(`Only http and https links are supported (got "${url.protocol}").`)
  }
  const hostname = url.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateAddress(hostname)) {
    throw new InvalidUrlError('Links to localhost or private network addresses are not allowed.')
  }
  return url.href
}
