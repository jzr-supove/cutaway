#!/usr/bin/env node
/**
 * Checks that the external tools Cutaway shells out to are present and usable.
 * Run with: npm run doctor
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const YTDLP = process.env.YTDLP_BIN ?? 'yt-dlp'
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe'

let failures = 0

function report(ok, label, detail) {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function checkVersion(bin, args, label, extract) {
  try {
    const { stdout, stderr } = await run(bin, args)
    report(true, label, extract(`${stdout}${stderr}`))
  } catch (err) {
    report(
      false,
      label,
      err.code === 'ENOENT'
        ? `"${bin}" is not on PATH — install it, or set the matching *_BIN environment variable`
        : err.message.split('\n')[0],
    )
  }
}

console.log('\nCutaway — environment check\n')

await checkVersion(YTDLP, ['--version'], 'yt-dlp', (out) => out.trim())
await checkVersion(FFMPEG, ['-version'], 'ffmpeg', (out) => out.split('\n')[0]?.trim() ?? '')
await checkVersion(FFPROBE, ['-version'], 'ffprobe', (out) => out.split('\n')[0]?.trim() ?? '')

try {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=320x240:r=30:d=0.2',
    '-c:v', 'h264_nvenc', '-f', 'null', '-',
  ])
  report(true, 'h264_nvenc (GPU encoder)', 'available — precise exports will be fast')
} catch {
  console.log('  --   h264_nvenc (GPU encoder) — not available, precise exports will use libx264 on the CPU')
}

// yt-dlp goes stale quickly; YouTube changes break older builds.
try {
  const { stdout } = await run(YTDLP, ['--version'])
  const version = stdout.trim()
  const parsed = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version)
  if (parsed) {
    const released = Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]))
    const ageDays = Math.floor((Date.now() - released) / 86_400_000)
    if (ageDays > 30) {
      console.log(
        `  --   yt-dlp is ${ageDays} days old (${version}) — sites break older builds often; run: yt-dlp -U`,
      )
    }
  }
} catch {
  /* the version check above already reported this */
}

console.log(
  failures === 0
    ? '\nAll required tools are present.\n'
    : `\n${failures} required tool(s) missing. Install them before running the app.\n`,
)
process.exit(failures === 0 ? 0 : 1)
