import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchKeyframes, resolveVideo, startDownload, startExport } from './api.ts'
import { clamp, formatDuration, formatTimecode } from './format.ts'
import { useJob } from './hooks/useJob.ts'
import { ExportPanel } from './components/ExportPanel.tsx'
import { JobProgress } from './components/JobProgress.tsx'
import { TimeField } from './components/TimeField.tsx'
import { Timeline } from './components/Timeline.tsx'
import { UrlBar } from './components/UrlBar.tsx'
import type { DownloadResult, ExportMode, ExportResult, Settings, VideoMeta } from './types.ts'

const MIN_SELECTION = 0.05
const SETTINGS_KEY = 'cutaway.settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        maxHeight: typeof parsed.maxHeight === 'number' ? parsed.maxHeight : 1080,
        cookiesFromBrowser: typeof parsed.cookiesFromBrowser === 'string' ? parsed.cookiesFromBrowser : null,
      }
    }
  } catch {
    /* corrupt or unavailable storage falls through to defaults */
  }
  return { maxHeight: 1080, cookiesFromBrowser: null }
}

export default function App() {
  const [url, setUrl] = useState('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nvenc, setNvenc] = useState(false)

  const [downloadJobId, setDownloadJobId] = useState<string | null>(null)
  const [exportJobId, setExportJobId] = useState<string | null>(null)
  const [source, setSource] = useState<DownloadResult | null>(null)

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [inPoint, setInPoint] = useState(0)
  const [outPoint, setOutPoint] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [volume, setVolume] = useState(1)
  const [mode, setMode] = useState<ExportMode>('precise')
  const [keyframes, setKeyframes] = useState<number[]>([])

  const videoRef = useRef<HTMLVideoElement>(null)
  const resumeAfterScrub = useRef(false)

  const downloadJob = useJob<DownloadResult>(downloadJobId)
  const exportJob = useJob<ExportResult>(exportJobId)

  const frameStep = 1 / (meta?.fps && meta.fps > 0 ? meta.fps : 30)

  // Mirrors for the animation frame loop, which must not close over stale state.
  const liveRef = useRef({ loop, inPoint, outPoint })
  liveRef.current = { loop, inPoint, outPoint }

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data: { nvenc?: boolean }) => setNvenc(Boolean(data.nvenc)))
      .catch(() => setNvenc(false))
  }, [])

  useEffect(() => {
    if (downloadJob?.status === 'done' && downloadJob.result) setSource(downloadJob.result)
  }, [downloadJob?.status, downloadJob?.result])

  // Probing keyframes reads every packet, so only pay for it once the user has
  // actually chosen the mode whose accuracy depends on them.
  useEffect(() => {
    if (!source || mode !== 'instant') return
    let cancelled = false
    void fetchKeyframes(source.file).then((times) => {
      if (!cancelled) setKeyframes(times)
    })
    return () => {
      cancelled = true
    }
  }, [source, mode])

  useEffect(() => {
    setKeyframes([])
  }, [source])

  /**
   * A single rAF loop drives the playhead and range looping. `timeupdate` fires
   * only ~4x/second, which is too coarse for a smooth playhead and lets loop
   * playback overshoot the out point by a visible margin.
   */
  useEffect(() => {
    let raf = 0
    let lastTime = -1

    const tick = () => {
      const video = videoRef.current
      if (video) {
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime
          setCurrentTime(video.currentTime)
        }
        const { loop: looping, inPoint: start, outPoint: end } = liveRef.current
        if (!video.paused && looping && end > start && video.currentTime >= end) {
          video.currentTime = start
        }
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seek = useCallback((time: number) => {
    const video = videoRef.current
    if (!video) return
    const limit = Number.isFinite(video.duration) ? video.duration : 0
    const next = clamp(time, 0, limit)
    video.currentTime = next
    setCurrentTime(next)
  }, [])

  const changeIn = useCallback(
    (time: number) => {
      setInPoint(time)
      seek(time)
    },
    [seek],
  )

  const changeOut = useCallback(
    (time: number) => {
      setOutPoint(time)
      seek(time)
    },
    [seek],
  )

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // Restart from the in point when playback already ran past the selection.
      if (loop && (video.currentTime < inPoint - 0.05 || video.currentTime >= outPoint)) {
        video.currentTime = inPoint
      }
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [loop, inPoint, outPoint])

  const stepFrame = useCallback(
    (direction: number) => {
      const video = videoRef.current
      if (!video) return
      video.pause()
      seek(video.currentTime + direction * frameStep)
    },
    [seek, frameStep],
  )

  const handleScrubStart = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    resumeAfterScrub.current = !video.paused
    video.pause()
  }, [])

  const handleScrubEnd = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (resumeAfterScrub.current) void video.play().catch(() => {})
    resumeAfterScrub.current = false
  }, [])

  const load = useCallback(async () => {
    setError(null)
    setMeta(null)
    setSource(null)
    setDownloadJobId(null)
    setExportJobId(null)
    setResolving(true)
    try {
      const resolved = await resolveVideo(url, settings)
      setMeta(resolved.meta)
      const { jobId } = await startDownload(resolved.url, settings)
      setDownloadJobId(jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolving(false)
    }
  }, [url, settings])

  const runExport = useCallback(async () => {
    if (!source) return
    setError(null)
    setExportJobId(null)
    try {
      const { jobId } = await startExport({
        file: source.file,
        start: inPoint,
        end: outPoint,
        mode,
        title: source.meta.title,
      })
      setExportJobId(jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [source, inPoint, outPoint, mode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!source || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName))
      ) {
        return
      }
      const video = videoRef.current
      if (!video) return

      const handlers: Record<string, () => void> = {
        ' ': togglePlay,
        i: () => changeIn(Math.min(video.currentTime, outPoint - MIN_SELECTION)),
        o: () => changeOut(Math.max(video.currentTime, inPoint + MIN_SELECTION)),
        ',': () => stepFrame(-1),
        '.': () => stepFrame(1),
        l: () => setLoop((value) => !value),
        ArrowLeft: () => seek(video.currentTime - (event.shiftKey ? 5 : 1)),
        ArrowRight: () => seek(video.currentTime + (event.shiftKey ? 5 : 1)),
        Home: () => seek(inPoint),
        End: () => seek(outPoint),
      }

      const handler = handlers[event.key] ?? handlers[event.key.toLowerCase()]
      if (!handler) return
      event.preventDefault()
      handler()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [source, inPoint, outPoint, togglePlay, stepFrame, seek, changeIn, changeOut])

  const busy = resolving || downloadJob?.status === 'running'
  const selectionLength = Math.max(0, outPoint - inPoint)

  return (
    <div className="app">
      <header className="header">
        <h1>
          <span aria-hidden>✂️</span> Cutaway
        </h1>
        <p>Paste a link, trim it, export the clip.</p>
      </header>

      <UrlBar
        url={url}
        busy={Boolean(busy)}
        settings={settings}
        onUrlChange={setUrl}
        onSubmit={() => void load()}
        onSettingsChange={setSettings}
      />

      {error && <p className="alert alert-error">{error}</p>}
      {downloadJob?.status === 'error' && <p className="alert alert-error">{downloadJob.error}</p>}

      {meta && (
        <section className="panel meta-card">
          {meta.thumbnail && <img className="meta-thumb" src={meta.thumbnail} alt="" />}
          <div className="meta-info">
            <strong>{meta.title}</strong>
            <span className="meta-sub">
              {[meta.uploader, meta.duration ? formatDuration(meta.duration) : null, meta.extractor]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {downloadJob?.status === 'done' && downloadJob.result?.cached && (
              <span className="meta-badge">Loaded from cache</span>
            )}
          </div>
        </section>
      )}

      {downloadJob?.status === 'running' && (
        <div className="panel">
          <JobProgress job={downloadJob} />
        </div>
      )}

      {source && (
        <>
          <section className="panel editor">
            <video
              key={source.file}
              ref={videoRef}
              className="video"
              src={source.mediaUrl}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget
                const length = Number.isFinite(video.duration) ? video.duration : 0
                setDuration(length)
                setInPoint(0)
                setOutPoint(length)
                setCurrentTime(0)
                video.volume = volume
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
            />

            <Timeline
              duration={duration}
              inPoint={inPoint}
              outPoint={outPoint}
              currentTime={currentTime}
              filmstripUrl={source.filmstripUrl}
              frameStep={frameStep}
              keyframes={mode === 'instant' ? keyframes : []}
              onSeek={seek}
              onChangeIn={changeIn}
              onChangeOut={changeOut}
              onScrubStart={handleScrubStart}
              onScrubEnd={handleScrubEnd}
            />

            <div className="transport">
              <button className="button" type="button" onClick={togglePlay}>
                {playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button className="button button-ghost" type="button" onClick={() => stepFrame(-1)}>
                ◀ Frame
              </button>
              <button className="button button-ghost" type="button" onClick={() => stepFrame(1)}>
                Frame ▶
              </button>
              <label className="toggle">
                <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
                Loop selection
              </label>
              <label className="volume">
                <span aria-hidden>🔊</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setVolume(next)
                    if (videoRef.current) videoRef.current.volume = next
                  }}
                />
              </label>
              <span className="transport-time">
                {formatTimecode(currentTime)} <span className="dim">/ {formatTimecode(duration)}</span>
              </span>
            </div>

            <div className="trim-fields">
              <TimeField
                label="Start"
                value={inPoint}
                max={Math.max(0, outPoint - MIN_SELECTION)}
                onCommit={changeIn}
                onSetFromPlayhead={() => changeIn(Math.min(currentTime, outPoint - MIN_SELECTION))}
              />
              <TimeField
                label="End"
                value={outPoint}
                max={duration}
                onCommit={changeOut}
                onSetFromPlayhead={() => changeOut(Math.max(currentTime, inPoint + MIN_SELECTION))}
              />
            </div>

            <p className="hints">
              <kbd>Space</kbd> play · <kbd>I</kbd>/<kbd>O</kbd> set start/end · <kbd>,</kbd>/<kbd>.</kbd>{' '}
              step a frame · <kbd>←</kbd>/<kbd>→</kbd> seek · <kbd>L</kbd> loop
            </p>
          </section>

          <ExportPanel
            selectionLength={selectionLength}
            inPoint={inPoint}
            keyframes={keyframes}
            mode={mode}
            job={exportJob}
            nvenc={nvenc}
            onModeChange={setMode}
            onExport={() => void runExport()}
          />
        </>
      )}
    </div>
  )
}
