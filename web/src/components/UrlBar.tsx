import { useState } from 'react'
import type { Settings } from '../types.ts'

const BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium']
const HEIGHTS = [360, 480, 720, 1080, 1440, 2160]

interface UrlBarProps {
  url: string
  busy: boolean
  settings: Settings
  onUrlChange: (url: string) => void
  onSubmit: () => void
  onSettingsChange: (settings: Settings) => void
}

export function UrlBar({ url, busy, settings, onUrlChange, onSubmit, onSettingsChange }: UrlBarProps) {
  const [showSettings, setShowSettings] = useState(false)

  return (
    <div className="urlbar">
      <form
        className="urlbar-row"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) onSubmit()
        }}
      >
        <input
          className="urlbar-input"
          type="url"
          inputMode="url"
          placeholder="Paste a YouTube, VK, Instagram… link"
          value={url}
          spellCheck={false}
          autoFocus
          onChange={(event) => onUrlChange(event.target.value)}
        />
        <button className="button button-primary" type="submit" disabled={busy || url.trim() === ''}>
          {busy ? 'Loading…' : 'Load video'}
        </button>
        <button
          className="button button-ghost"
          type="button"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((open) => !open)}
        >
          Settings
        </button>
      </form>

      {showSettings && (
        <div className="settings">
          <label className="settings-field">
            <span>Max resolution</span>
            <select
              value={settings.maxHeight}
              onChange={(event) =>
                onSettingsChange({ ...settings, maxHeight: Number(event.target.value) })
              }
            >
              {HEIGHTS.map((height) => (
                <option key={height} value={height}>
                  {height}p
                </option>
              ))}
            </select>
            <small>Lower resolutions download faster.</small>
          </label>

          <label className="settings-field">
            <span>Use browser cookies</span>
            <select
              value={settings.cookiesFromBrowser ?? ''}
              onChange={(event) =>
                onSettingsChange({ ...settings, cookiesFromBrowser: event.target.value || null })
              }
            >
              <option value="">Off</option>
              {BROWSERS.map((browser) => (
                <option key={browser} value={browser}>
                  {browser[0]?.toUpperCase()}
                  {browser.slice(1)}
                </option>
              ))}
            </select>
            <small>
              Needed for private, age-restricted or login-only videos. Close the browser first —
              it locks its own cookie database.
            </small>
          </label>
        </div>
      )}
    </div>
  )
}
