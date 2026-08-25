# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cutaway is a local-first video trimmer: paste a URL, `yt-dlp` downloads it into `cache/`, the
browser previews it while you drag trim handles, `ffmpeg` cuts the clip into `exports/`.
Single-user, no auth, binds `127.0.0.1` only.

## Commands

```bash
npm install
npm run doctor      # verify yt-dlp / ffmpeg / ffprobe are on PATH (also runs in CI)
npm run dev         # server on :3001 + Vite on :5173 (open 5173; /api is proxied)
npm run typecheck   # both workspaces — the primary correctness gate
npm run build       # web/dist
npm start           # single process: API + built frontend on :3001
```

There is **no test suite and no linter**. CI runs `typecheck`, `build`, then `doctor` against
freshly installed `yt-dlp`/`ffmpeg` — so `doctor` drifting from the flags the server actually
passes is a CI failure. Before claiming a change works, run `typecheck` and `build`; anything
touching download or export behavior needs a manual run against a real URL.

`yt-dlp` and `ffmpeg` are external prerequisites, never bundled (see Licensing in README —
bundling a GPL ffmpeg build would change this repo's MIT obligations). Do not vendor them.

## Architecture

npm workspaces: `server/` (Fastify + tsx, no build step — `.ts` runs directly, imports use
explicit `.ts` extensions) and `web/` (React 19 + Vite).

Request flow:

```
POST /api/resolve   → yt-dlp -J metadata only, cached 5 min so /download doesn't re-probe
POST /api/download  → job id; yt-dlp into cache/, then ensureFastStart()
GET  /api/jobs/:id/events → SSE progress, server closes the stream when the job settles
GET  /api/media/:file     → @fastify/static with Range support (this is what makes scrubbing instant)
GET  /api/filmstrip/:file → ffmpeg tile strip, built on demand, deduped per file
GET  /api/keyframes/:file → ffprobe packet flags; only fetched when Instant mode is selected
POST /api/export    → job id; ffmpeg into exports/
```

**Jobs** (`services/jobs.ts`) are an in-memory registry keyed by UUID, each with an
EventEmitter; SSE subscribers get current state immediately then every change. Finished jobs
are pruned after 30 min. Nothing survives a restart — that's intentional for a single-user
local tool.

**Deduplication** happens in two places: `startDownload` maps `cacheKey → jobId` so a second
request for the same video mirrors the running job instead of downloading twice, and
`filmstripJobs` shares one ffmpeg run per strip.

**Cache identity** is `extractor-id-<height>p`; `findCached` ignores yt-dlp's `.part`/fragment
artifacts and touches mtime so LRU eviction (`enforceCacheLimit`, 20 GB default) sees the
access. `--no-mtime` is passed to yt-dlp for the same reason.

**`ClipExporter`** in `services/ffmpeg.ts` is a deliberate seam — routes depend on the
interface, not on ffmpeg, so a WebCodecs browser exporter can be dropped in later. Keep
export logic behind it.

**Frontend state** lives almost entirely in `App.tsx`; components are presentational. Two
patterns recur and are load-bearing:

- A single `requestAnimationFrame` loop drives the playhead and loop-back, because
  `timeupdate` fires ~4×/s — too coarse for a smooth playhead and it overshoots the out point.
- Rapidly-changing props are mirrored into a `useRef` (`liveRef` in `App.tsx`, `propsRef` in
  `Timeline.tsx`) so rAF/pointer callbacks never read a stale closure. Pointer moves are
  coalesced to one update per frame.

## Invariants — these look arbitrary and are not

Also documented in CONTRIBUTING.md; changing any of them breaks something no test covers.

- **Every external command goes through `run()` in `services/proc.ts`**, spawned with an
  argument array and `shell: false`. Never build a command string; never add `shell: true`.
  A video title or URL is untrusted input.
- **`--` stays immediately before the URL** in every `yt-dlp` argument list, so a link
  starting with `-` cannot be read as a flag.
- **`-ss` goes before `-i`.** In ffmpeg 5+ that is both frame-accurate and fast. The common
  advice to put it after `-i` is outdated. Consequently output timestamps rebase to zero, so
  use `-t`, not `-to`, and progress parsing reads `out_time_us` against that rebased timeline.
- **`+faststart` is load-bearing.** `ensureFastStart()` checks every download because yt-dlp
  only applies the flag during merge/remux, so a single pre-muxed MP4 slips through. Without
  moov-first the browser can't seek until the whole file arrives, which breaks the entire app.
- **Client filenames go through `resolveInside()`** in `routes/api.ts`. Never join a request
  value onto a directory without it, and never re-decode the parameter — Fastify already
  decoded it, and decoding twice lets `%252e%252e` through as `..`.
- **URLs go through `validateSourceUrl()`** (`services/url.ts`): http(s) only, and loopback /
  private / link-local / CGNAT addresses rejected (SSRF).
- **Browser names for `--cookies-from-browser` are allowlisted** in both `routes/api.ts` and
  `services/ytdlp.ts`. Keep the two lists in sync.
- **The server binds `127.0.0.1`.** There is no authentication; don't make the bind address
  configurable without an auth story.

## Error handling convention

yt-dlp and ffmpeg stderr is translated into an actionable user-facing sentence by
`translateYtdlpError` / `translateFfmpegError` (pattern → message tables). New failure modes
belong in those tables, not as raw stderr surfaced to the UI. A transient 403/network failure
from yt-dlp is retried once silently — YouTube hands out URLs that expire in seconds.

## Style

TypeScript, ES modules, no default exports (except `App.tsx`). `strict` plus
`noUncheckedIndexedAccess` in both workspaces. Comments explain *why* — most existing comments
exist to mark a line that looks wrong but is deliberate; keep that. No new dependencies without
a reason; the dependency list is short on purpose.
