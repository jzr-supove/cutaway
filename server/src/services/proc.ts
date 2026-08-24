import { spawn } from 'node:child_process'

export interface ProcResult {
  code: number
  stdout: string
  stderr: string
}

export class ProcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'ProcError'
  }
}

export interface RunOptions {
  /** Called for every complete line on either stream. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  signal?: AbortSignal
  /** Keep at most this many stderr characters for error reporting. */
  stderrLimit?: number
  /** Buffer stdout in memory (needed for JSON output, wasteful otherwise). */
  captureStdout?: boolean
}

/**
 * Spawn a binary with an argument array. Never uses a shell, so user-supplied
 * strings (URLs, titles, paths) cannot be interpreted as shell syntax.
 */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<ProcResult> {
  const { onLine, signal, stderrLimit = 16_000, captureStdout = true } = opts

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, signal })

    let stdout = ''
    let stderr = ''
    const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }

    const attach = (stream: 'stdout' | 'stderr') => {
      child[stream].setEncoding('utf8')
      child[stream].on('data', (chunk: string) => {
        if (stream === 'stdout' && captureStdout) stdout += chunk
        if (stream === 'stderr') {
          stderr += chunk
          if (stderr.length > stderrLimit) stderr = stderr.slice(-stderrLimit)
        }
        if (!onLine) return
        // ffmpeg uses \r for in-place progress; treat it as a line break too.
        const buffered = partial[stream] + chunk
        const lines = buffered.split(/\r\n|\r|\n/)
        partial[stream] = lines.pop() ?? ''
        for (const line of lines) if (line.length) onLine(line, stream)
      })
    }

    attach('stdout')
    attach('stderr')

    child.on('error', (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `"${bin}" was not found on PATH. Install it, or set the matching *_BIN environment variable.`
          : err.message
      reject(new ProcError(hint, -1, stderr))
    })

    child.on('close', (code) => {
      if (onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          const rest = partial[stream]
          if (rest.length) onLine(rest, stream)
        }
      }
      if (code === 0) resolve({ code, stdout, stderr })
      else reject(new ProcError(`${bin} exited with code ${code}`, code ?? -1, stderr))
    })
  })
}
