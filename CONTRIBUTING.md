# Contributing to Cutaway

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

```bash
npm install
npm run doctor   # confirms yt-dlp, ffmpeg and ffprobe are reachable
npm run dev      # http://localhost:5173
```

Before opening a PR:

```bash
npm run typecheck
npm run build
```

Both run in CI, so a failure there will block the merge anyway.

## Reporting a bug

The two most common reports are not bugs in Cutaway, so please rule them out first:

1. **A site stopped working.** Run `yt-dlp -U`. Extractors break constantly and Cutaway
   only drives `yt-dlp` — if `yt-dlp <url>` fails on its own, the issue belongs
   [upstream](https://github.com/yt-dlp/yt-dlp/issues).
2. **Instant export started earlier than you asked.** That is stream copy snapping to a
   keyframe, and it is expected. The timeline shows the keyframes when Instant is
   selected. Use Precise for an exact cut.

For anything else, include the output of `npm run doctor`, your OS, and the failing URL
if it is public.

**Security issues** go to
[security advisories](https://github.com/jzr-supove/cutaway/security/advisories/new), not
to public issues.

## Things to know before changing code

A few decisions in here look arbitrary and are not. Changing them will break something
that is not covered by a test.

- **All external commands go through `run()` in `server/src/services/proc.ts`.** It spawns
  with an argument array and `shell: false`. Never build a command string, and never add
  `shell: true` — a video title or URL is untrusted input.
- **`--` must stay immediately before the URL** in the `yt-dlp` argument list, so a link
  beginning with `-` cannot be parsed as a flag.
- **`+faststart` is load-bearing.** If the `moov` atom is not at the front of the file the
  browser cannot seek until the whole thing downloads, which breaks the entire point of
  the app. `ensureFastStart()` in `services/ffmpeg.ts` checks every download, because
  `yt-dlp` only applies the flag during a merge or remux.
- **`-ss` goes before `-i`.** In ffmpeg 5+ this is both accurate and fast. Moving it after
  `-i` is the widely repeated advice and it is outdated.
- **Filenames from the client are resolved with `resolveInside()`** in `routes/api.ts`.
  Do not add a route that joins a request value onto a directory without it, and do not
  re-decode the parameter — Fastify already did, and decoding twice would let
  `%252e%252e` through as `..`.
- **The server binds `127.0.0.1` only.** There is no authentication. Please do not send a
  PR making the bind address configurable without an auth story to go with it.

## Scope

The [roadmap](README.md#roadmap) lists what is deliberately deferred. Features outside it
are still worth proposing — open an issue first so we can talk about it before you spend
time on the code.

The one hard boundary: Cutaway does not bundle `yt-dlp` or `ffmpeg`, and PRs that add
them as vendored binaries or into a release archive will be declined. Invoking them at
arm's length is what keeps this codebase MIT-licensed; shipping a GPL ffmpeg build inside
a release changes the obligations. See [Licensing](README.md#licensing).

## Style

Match the surrounding code. Practically:

- TypeScript, ES modules, no default exports.
- Comments explain *why*, not *what*. If a line looks wrong but is deliberate, say so —
  most of the comments in this repo exist for that reason.
- No new dependencies without a reason in the PR description. The dependency list is
  short on purpose.

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
