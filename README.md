<h1 align="center">Cutaway</h1>

<p align="center">
  Paste a video link. Trim it in your browser with live preview. Export the clip.
</p>

<p align="center">
  <a href="https://github.com/jzr-supove/cutaway/actions/workflows/ci.yml"><img src="https://github.com/jzr-supove/cutaway/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg" alt="Node >= 20.11">
</p>

<!-- TODO: drop a demo.gif here - it is the single highest-value thing this README is missing. -->

---

Cutting a ten-second clip out of an online video usually costs you five steps: find a
downloader site that still works for *that* platform, wait, open a video editor, hunt for
the in and out points, export.

Cutaway is those five steps in one page. Paste a URL, drag two handles while the video
previews under your cursor, export. Works with YouTube, VK, Instagram and the ~1800 other
sites [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) supports.

It runs entirely on your own machine.

## Features

- **Any source** — anything `yt-dlp` can reach, using one interface instead of one sketchy site per platform.
- **Live preview while trimming** — the video frame follows the handle as you drag it, so you see the exact cut before you commit.
- **Two export modes** — frame-accurate re-encode (GPU-accelerated where available), or an instant lossless stream copy.
- **Honest keyframes** — instant mode can only start on a keyframe. Cutaway draws them on the timeline and tells you where the cut will *really* land, instead of silently giving you three extra seconds.
- **Filmstrip timeline** — thumbnails across the track so you can find the moment by eye.
- **Frame-accurate keyboard control** — `I`/`O` to mark, `,`/`.` to step one frame, `L` to loop the selection.
- **Cached sources** — re-trimming a video you already pulled never downloads it twice.
- **Private videos** — optionally reuse your browser's own cookies for login-only or age-restricted content.

## Requirements

| | |
| --- | --- |
| [Node.js](https://nodejs.org) | 20.11 or newer |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) | on your `PATH` |
| [ffmpeg](https://ffmpeg.org/download.html) + `ffprobe` | on your `PATH` |

Cutaway **does not bundle** either tool — it invokes whichever copy you installed. See
[Licensing](#licensing) for why that distinction matters.

Verify everything at once:

```bash
npm run doctor
```

An NVIDIA GPU is optional. If `h264_nvenc` is present it is used for precise exports;
otherwise they fall back to `libx264` on the CPU.

## Quick start

```bash
git clone https://github.com/jzr-supove/cutaway.git
cd cutaway
npm install
npm run dev
```

Open **http://localhost:5173**.

The API binds to `127.0.0.1:3001`; the Vite dev server proxies `/api` to it.

For a single-process run:

```bash
npm run build   # bundles the frontend into web/dist
npm start       # serves the app and the API on http://127.0.0.1:3001
```

## Using it

1. Paste a link and press **Load video**.
2. Drag the two handles on the timeline. The preview follows as you drag.
3. Press **Export clip**, then **Download**.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `I` / `O` | Set start / end at the playhead |
| `,` / `.` | Step one frame back / forward |
| `←` / `→` | Seek 1s (hold `Shift` for 5s) |
| `Home` / `End` | Jump to start / end point |
| `L` | Toggle loop-selection playback |

Arrow keys nudge a trim handle by one frame when the handle itself is focused.

### Export modes

| | Precise | Instant |
| --- | --- | --- |
| Accuracy | Exact — verified within one frame | Start snaps back to the nearest keyframe |
| Quality | Re-encoded (H.264, CQ 20) | Lossless stream copy |
| Speed | Seconds on GPU, slower on CPU | Near-instant |

Stream copying cannot begin mid-GOP. That is a property of the container format, not a
bug, and most tools hide it. Cutaway does not: select **Instant** and the timeline draws
every keyframe as a yellow tick while the panel states the real start time. On a source
with keyframes every ~5s, asking for 3.0s genuinely gives you 0.0s.

Use **Precise** when the frame matters, **Instant** when you want the original bytes
untouched.

### Private, age-restricted or login-only videos

Open **Settings → Use browser cookies** and pick the browser you are signed into. Close
that browser first — it holds a lock on its own cookie database.

## How it works

```
browser  ──POST /api/resolve──►  yt-dlp -J      (metadata only, no download)
         ──POST /api/download─►  yt-dlp         (progress streamed over SSE)
         ◄──GET /api/media/…──   cached file    (HTTP Range → instant seeking)
         ──POST /api/export───►  ffmpeg         (progress streamed over SSE)
```

**Why there is a server at all.** The download step cannot run in a browser, and this is
structural rather than a matter of effort:

- Video CDNs send no `Access-Control-Allow-Origin` header, so a page's `fetch()` is
  blocked by CORS. A "CORS proxy" to work around that is itself a server.
- YouTube requires a proof-of-origin token derived from executing its own JavaScript
  challenge, plus signature decryption. Reimplementing that *is* what `yt-dlp` does.
- Instagram and VK need an authenticated session.

The **trim and export** step, by contrast, could run client-side via WebCodecs. It is kept
behind a `ClipExporter` interface in `server/src/services/ffmpeg.ts` precisely so a
browser implementation can be dropped in without touching the routes — see
[Roadmap](#roadmap).

### Details that matter

- **`moov` atom first.** Every download is checked and losslessly remuxed with
  `+faststart` if the index sits at the end of the file. Without this the browser cannot
  seek until the whole file arrives, which would break the core interaction. `yt-dlp`
  only applies it during a merge or remux, so a single pre-muxed MP4 slips through — the
  check runs regardless.
- **H.264 preferred.** Format selection sorts by resolution, then prefers H.264/AAC, so
  `<video>` can play it and a stream-copy export stays a valid MP4.
- **`-ss` before `-i`.** In ffmpeg 5+ this is both frame-accurate *and* fast; it seeks to
  the prior keyframe and decodes forward. The widespread advice to put `-ss` after `-i`
  for accuracy is outdated and much slower.
- **Transient 403s are retried once.** YouTube intermittently rejects URLs that were valid
  moments earlier; re-running the extractor mints fresh ones.
- **Every external command is spawned with an argument array**, never a shell string.

## Configuration

All optional:

| Variable | Default |
| --- | --- |
| `PORT` | `3001` |
| `CLIP_CACHE_DIR` | `./cache` |
| `CLIP_EXPORT_DIR` | `./exports` |
| `CLIP_CACHE_MAX_BYTES` | `21474836480` (20 GB) |
| `CLIP_MAX_HEIGHT` | `1080` |
| `YTDLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN` | `yt-dlp` / `ffmpeg` / `ffprobe` |

`cache/` holds downloaded sources and filmstrips; `exports/` holds finished clips. The
cache evicts least-recently-used sources above the size cap. Both are git-ignored and
safe to delete.

## Security

> [!WARNING]
> Cutaway has **no authentication**. It binds to `127.0.0.1` only and is not reachable
> from your network. Do not put it behind a public reverse proxy, expose the container
> port, or change the bind address — that would hand anyone who finds it the ability to
> run downloads and writes on your machine.

Within that single-user model:

- Every external command is spawned with an argument array and `shell: false`, so shell
  metacharacters in a URL or title are never interpreted.
- `--` terminates option parsing before the URL, so a link cannot pose as a `yt-dlp` flag.
- URLs must be `http(s)` and are rejected if they point at loopback, private, link-local
  or carrier-grade-NAT addresses.
- Client-supplied filenames are resolved against a fixed directory and rejected if they
  contain any path separator.

Found something? Please open a
[security advisory](https://github.com/jzr-supove/cutaway/security/advisories/new) rather
than a public issue.

## Licensing

Cutaway itself is [MIT](LICENSE).

It invokes `yt-dlp` and `ffmpeg` as **separate processes** and does not link against
them, so their licenses do not extend to this codebase. This is the ordinary
arm's-length-invocation case, and it holds **only because the binaries are never
bundled**.

If you fork this and ship an installer, a Docker image, or a release archive that
*includes* an `ffmpeg` build, that changes: most distributed ffmpeg builds are compiled
with `--enable-gpl` (libx264 among them), and redistributing one obliges you to comply
with the GPL for that binary. Keep shipping the tools as a user-installed prerequisite
and the question never comes up.

## Legal

Cutaway is a tool. What you point it at is your responsibility.

Downloading content may breach a platform's Terms of Service and, depending on the
content and your jurisdiction, copyright law. Use it for material you own, have
permission to use, or that a legal exception in your country covers. The authors provide
no warranty and accept no liability for how it is used.

## Roadmap

Deliberately out of scope for v1, in rough order of value:

- [ ] **Audio-only export** — MP3/M4A extraction alongside the video clip.
- [ ] **Multiple clips per download** — mark several ranges, batch export. Cheap, since the source is already cached.
- [ ] **Vertical 9:16 crop** for Shorts/Reels — draggable crop box on the precise path.
- [ ] **GIF export.**
- [ ] **Client-side WebCodecs exporter** — implements `ClipExporter` in the browser. This is the prerequisite for ever hosting Cutaway, since it moves all CPU cost off the server. Expect two obstacles: browser memory limits on long or 4K sources, and datacenter-IP bot-blocking on the download side.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

**"Sign in to confirm you're not a bot"** — enable *Settings → Use browser cookies*.

**HTTP 403, or "yt-dlp could not find a video"** — usually a stale `yt-dlp`. Run
`yt-dlp -U`. Sites break older builds constantly; `npm run doctor` warns when yours is
over a month old.

**Seeking is slow on a long video** — the `+faststart` pass did not apply. Delete the file
from `cache/` and load it again.

**Export fails in Instant mode** — some sources cannot be copied losslessly into MP4.
Switch to Precise.

---

Built with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org).
