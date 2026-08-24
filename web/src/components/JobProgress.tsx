import type { JobState } from '../types.ts'

export function JobProgress({ job }: { job: JobState<unknown> }) {
  const indeterminate = job.percent === null

  return (
    <div className="progress">
      <div className="progress-bar">
        <div
          className={`progress-fill ${indeterminate ? 'progress-fill-indeterminate' : ''}`}
          style={indeterminate ? undefined : { width: `${job.percent}%` }}
        />
      </div>
      <div className="progress-text">
        <span>{job.phase}</span>
        <span>
          {job.speed && <span className="progress-meta">{job.speed}</span>}
          {job.eta && <span className="progress-meta">{job.eta} left</span>}
          {!indeterminate && <span>{Math.round(job.percent ?? 0)}%</span>}
        </span>
      </div>
    </div>
  )
}
