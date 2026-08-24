import { useEffect, useState } from 'react'
import { formatTimecode, parseTimecode } from '../format.ts'

interface TimeFieldProps {
  label: string
  value: number
  max: number
  onCommit: (time: number) => void
  onSetFromPlayhead: () => void
}

/**
 * Editable timecode. Typing is kept in a local draft so a half-finished value
 * like "1:" never moves the trim point; the draft resyncs whenever the value
 * changes from elsewhere (dragging a handle, a keyboard shortcut).
 */
export function TimeField({ label, value, max, onCommit, onSetFromPlayhead }: TimeFieldProps) {
  const [draft, setDraft] = useState(() => formatTimecode(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(formatTimecode(value))
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const parsed = parseTimecode(draft)
    if (parsed === null || parsed > max) {
      setDraft(formatTimecode(value))
      return
    }
    onCommit(parsed)
  }

  return (
    <div className="timefield">
      <span className="timefield-label">{label}</span>
      <input
        className="timefield-input"
        value={draft}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(formatTimecode(value))
            setEditing(false)
            event.currentTarget.blur()
          }
        }}
      />
      <button className="button button-ghost button-small" type="button" onClick={onSetFromPlayhead}>
        Set here
      </button>
    </div>
  )
}
