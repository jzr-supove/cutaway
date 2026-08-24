import { formatBytes, formatTimecode } from '../format.ts'
import type { ExportMode, ExportResult, JobState } from '../types.ts'

interface ExportPanelProps {
  selectionLength: number
  inPoint: number
  keyframes: number[]
  mode: ExportMode
  job: JobState<ExportResult> | null
  nvenc: boolean
  onModeChange: (mode: ExportMode) => void
  onExport: () => void
}

/** Greatest keyframe at or before `time` — where a stream copy would actually begin. */
function snapToKeyframe(keyframes: number[], time: number): number | null {
  if (keyframes.length === 0) return null
  let best: number | null = null
  for (const candidate of keyframes) {
    if (candidate > time + 0.001) break
    best = candidate
  }
  return best ?? 0
}

export function ExportPanel({
  selectionLength,
  inPoint,
  keyframes,
  mode,
  job,
  nvenc,
  onModeChange,
  onExport,
}: ExportPanelProps) {
  const running = job?.status === 'running'
  const result = job?.status === 'done' ? job.result : null

  const snapped = mode === 'instant' ? snapToKeyframe(keyframes, inPoint) : null
  const drift = snapped === null ? 0 : inPoint - snapped

  return (
    <section className="panel export-panel">
      <div className="export-modes">
        <ModeOption
          checked={mode === 'precise'}
          onSelect={() => onModeChange('precise')}
          title="Precise"
          detail={
            nvenc
              ? 'Exact frames. Re-encodes on the GPU — usually a few seconds.'
              : 'Exact frames. Re-encodes on the CPU — slower on long clips.'
          }
        />
        <ModeOption
          checked={mode === 'instant'}
          onSelect={() => onModeChange('instant')}
          title="Instant"
          detail="No quality loss and near-instant, but the cut snaps to the nearest keyframe (often 1–5s off)."
        />
      </div>

      {mode === 'instant' && snapped !== null && (
        <p className={`alert ${drift > 0.25 ? 'alert-warn' : 'alert-info'}`}>
          {drift > 0.25 ? (
            <>
              Instant will actually start at <strong>{formatTimecode(snapped)}</strong> —{' '}
              {drift.toFixed(1)}s earlier than your start point, at the nearest keyframe (shown as
              ticks on the timeline). Switch to Precise for an exact cut.
            </>
          ) : (
            <>
              Your start point is on a keyframe, so Instant will cut exactly here with no quality
              loss.
            </>
          )}
        </p>
      )}

      <div className="export-actions">
        <div className="export-length">
          <span className="export-length-value">{formatTimecode(selectionLength)}</span>
          <span className="export-length-label">selected</span>
        </div>
        <button
          className="button button-primary button-large"
          type="button"
          disabled={running || selectionLength <= 0}
          onClick={onExport}
        >
          {running ? 'Exporting…' : 'Export clip'}
        </button>
      </div>

      {running && (
        <div className="progress">
          <div className="progress-bar">
            <div
              className={`progress-fill ${job.percent === null ? 'progress-fill-indeterminate' : ''}`}
              style={job.percent === null ? undefined : { width: `${job.percent}%` }}
            />
          </div>
          <div className="progress-text">
            <span>{job.phase}</span>
            {job.percent !== null && <span>{Math.round(job.percent)}%</span>}
          </div>
        </div>
      )}

      {job?.status === 'error' && <p className="alert alert-error">{job.error}</p>}

      {result && (
        <div className="export-result">
          <div className="export-result-info">
            <strong>{result.file}</strong>
            <span>
              {formatTimecode(result.duration)} · {formatBytes(result.bytes)}
            </span>
          </div>
          <a className="button button-primary" href={result.downloadUrl} download={result.file}>
            Download
          </a>
        </div>
      )}
    </section>
  )
}

function ModeOption({
  checked,
  onSelect,
  title,
  detail,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  detail: string
}) {
  return (
    <label className={`export-mode ${checked ? 'export-mode-active' : ''}`}>
      <input type="radio" name="export-mode" checked={checked} onChange={onSelect} />
      <span className="export-mode-title">{title}</span>
      <span className="export-mode-detail">{detail}</span>
    </label>
  )
}
