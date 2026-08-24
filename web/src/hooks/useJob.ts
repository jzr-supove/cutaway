import { useEffect, useState } from 'react'
import type { JobState } from '../types.ts'

/**
 * Follows a server job over SSE. The server closes the stream once the job
 * settles, so there is nothing to poll and nothing to clean up on completion.
 */
export function useJob<R>(jobId: string | null): JobState<R> | null {
  const [state, setState] = useState<JobState<R> | null>(null)

  useEffect(() => {
    if (!jobId) {
      setState(null)
      return
    }

    let closed = false
    const source = new EventSource(`/api/jobs/${jobId}/events`)

    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as JobState<R>
      setState(next)
      if (next.status !== 'running') {
        closed = true
        source.close()
      }
    }

    source.onerror = () => {
      if (closed) return
      closed = true
      source.close()
      setState((previous) =>
        previous && previous.status !== 'running'
          ? previous
          : {
              id: jobId,
              kind: previous?.kind ?? 'download',
              status: 'error',
              phase: 'Failed',
              percent: null,
              speed: null,
              eta: null,
              result: null,
              error: 'Lost the connection to the local server.',
            },
      )
    }

    return () => {
      closed = true
      source.close()
    }
  }, [jobId])

  return state
}
