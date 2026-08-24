import { useEffect, useRef } from 'react'
import { clamp, formatTimecode } from '../format.ts'

/** Shortest selection the handles can be dragged to. */
const MIN_SELECTION = 0.05

type DragTarget = 'in' | 'out' | 'playhead'

interface TimelineProps {
  duration: number
  inPoint: number
  outPoint: number
  currentTime: number
  filmstripUrl: string | null
  frameStep: number
  /** Rendered as ticks when instant export is selected; empty otherwise. */
  keyframes: number[]
  onSeek: (time: number) => void
  onChangeIn: (time: number) => void
  onChangeOut: (time: number) => void
  onScrubStart: () => void
  onScrubEnd: () => void
}

export function Timeline(props: TimelineProps) {
  const { duration, inPoint, outPoint, currentTime, filmstripUrl, frameStep, keyframes } = props

  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragTarget | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingX = useRef(0)

  // Handlers change every render; the rAF callback reads them through a ref so
  // the drag never captures a stale closure.
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const timeAtClientX = (clientX: number): number => {
    const element = trackRef.current
    if (!element) return 0
    const rect = element.getBoundingClientRect()
    if (rect.width === 0) return 0
    const ratio = (clientX - rect.left) / rect.width
    return clamp(ratio * propsRef.current.duration, 0, propsRef.current.duration)
  }

  const applyPending = () => {
    frameRef.current = null
    const target = dragRef.current
    if (!target) return
    const p = propsRef.current
    const time = timeAtClientX(pendingX.current)

    if (target === 'in') p.onChangeIn(clamp(time, 0, p.outPoint - MIN_SELECTION))
    else if (target === 'out') p.onChangeOut(clamp(time, p.inPoint + MIN_SELECTION, p.duration))
    else p.onSeek(time)
  }

  // Pointer events fire far faster than the display refreshes; coalescing them
  // into one update per frame is what keeps dragging smooth on long videos.
  const schedule = (clientX: number) => {
    pendingX.current = clientX
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(applyPending)
  }

  const beginDrag = (target: DragTarget) => (event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = target
    trackRef.current?.setPointerCapture(event.pointerId)
    propsRef.current.onScrubStart()
    schedule(event.clientX)
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return
    schedule(event.clientX)
  }

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    pendingX.current = event.clientX
    applyPending()
    dragRef.current = null
    trackRef.current?.releasePointerCapture(event.pointerId)
    propsRef.current.onScrubEnd()
  }

  const nudge = (target: 'in' | 'out') => (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 1 : frameStep
    let delta = 0
    if (event.key === 'ArrowLeft') delta = -step
    else if (event.key === 'ArrowRight') delta = step
    else return

    event.preventDefault()
    if (target === 'in') props.onChangeIn(clamp(inPoint + delta, 0, outPoint - MIN_SELECTION))
    else props.onChangeOut(clamp(outPoint + delta, inPoint + MIN_SELECTION, duration))
  }

  const pct = (time: number) => (duration > 0 ? clamp((time / duration) * 100, 0, 100) : 0)
  const inPct = pct(inPoint)
  const outPct = pct(outPoint)

  return (
    <div className="timeline">
      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={beginDrag('playhead')}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {filmstripUrl ? (
          <img className="timeline-filmstrip" src={filmstripUrl} alt="" draggable={false} />
        ) : (
          <div className="timeline-filmstrip timeline-filmstrip-empty" />
        )}

        <div className="timeline-mask" style={{ left: 0, width: `${inPct}%` }} />
        <div className="timeline-mask" style={{ left: `${outPct}%`, right: 0 }} />
        <div
          className="timeline-selection"
          style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
        />

        {/* Long videos can have thousands of keyframes; past this many the ticks
            merge into a solid band anyway, so drawing them all only costs frames. */}
        {keyframes.length <= 1500 &&
          keyframes.map((time, index) => (
            <div key={`${time}-${index}`} className="timeline-keyframe" style={{ left: `${pct(time)}%` }} />
          ))}

        <div className="timeline-playhead" style={{ left: `${pct(currentTime)}%` }} />

        <div
          className="timeline-handle timeline-handle-in"
          style={{ left: `${inPct}%` }}
          onPointerDown={beginDrag('in')}
          onKeyDown={nudge('in')}
          role="slider"
          tabIndex={0}
          aria-label="Clip start"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={inPoint}
          aria-valuetext={formatTimecode(inPoint)}
        >
          <span className="timeline-handle-grip" />
        </div>

        <div
          className="timeline-handle timeline-handle-out"
          style={{ left: `${outPct}%` }}
          onPointerDown={beginDrag('out')}
          onKeyDown={nudge('out')}
          role="slider"
          tabIndex={0}
          aria-label="Clip end"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={outPoint}
          aria-valuetext={formatTimecode(outPoint)}
        >
          <span className="timeline-handle-grip" />
        </div>
      </div>

      <div className="timeline-ruler">
        <span>0:00</span>
        <span>{formatTimecode(duration)}</span>
      </div>
    </div>
  )
}
