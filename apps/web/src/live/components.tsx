import React from 'react'
import type { PadAssignment, PadState } from '@masterclip/performance-project'
import type { EngineSnapshot } from './engine.js'

/** Shared performance surfaces: the 16-pad grid, the stem deck, the transport. */

export function PadGrid({
  padMap,
  padStates,
  onTrigger,
  onSelect,
  large,
}: {
  padMap: PadAssignment[]
  padStates: PadState[]
  onTrigger: (index: number) => void
  /** Edit mode: select a pad for assignment instead of firing it. */
  onSelect?: (index: number) => void
  large?: boolean
}) {
  return (
    <div className={`pad-grid${large ? ' large' : ''}`}>
      {Array.from({ length: 16 }, (_, index) => {
        const pad = padMap.find((p) => p.index === index)
        const state = padStates[index] ?? 'empty'
        const label = pad?.label || (pad && pad.mode !== 'empty' ? pad.mode.replace('_', ' ').toUpperCase() : '')
        return (
          <button
            key={index}
            className={`pad state-${state}`}
            onClick={() => onTrigger(index)}
            onContextMenu={(event) => {
              if (!onSelect) return
              event.preventDefault()
              onSelect(index)
            }}
            title={onSelect ? 'click to trigger — right-click to assign' : label}
          >
            <span className="pad-label">{label || '—'}</span>
            <span className="pad-state">{state === 'empty' ? '' : state.toUpperCase()}</span>
          </button>
        )
      })}
    </div>
  )
}

export function TransportBar({
  snapshot,
  songTitle,
  nextTitle,
  onStop,
  onNext,
  onPrev,
  onToggleClick,
}: {
  snapshot: EngineSnapshot
  songTitle: string | null
  nextTitle: string | null
  onStop: () => void
  onNext: () => void
  onPrev: () => void
  onToggleClick: () => void
}) {
  return (
    <div className="transport">
      <div className="transport-position mono">
        <span className="transport-bar">{snapshot.playing ? `${snapshot.bar}.${snapshot.beat}` : '—.—'}</span>
        <span className="transport-bpm">{Math.round(snapshot.bpm)} BPM</span>
      </div>
      <div className="transport-song">
        <div className="transport-now">{songTitle ?? 'no song'}</div>
        {nextTitle && <div className="transport-next faint">next: {nextTitle}</div>}
      </div>
      <div className="button-row">
        <button className="small" onClick={onPrev}>
          ◀ prev
        </button>
        <button className="small" onClick={onNext}>
          next ▶
        </button>
        <button className={`small${snapshot.clickEnabled ? ' ok' : ''}`} onClick={onToggleClick}>
          click {snapshot.clickEnabled ? 'ON' : 'off'}
        </button>
        <button className="danger" onClick={onStop}>
          ■ STOP
        </button>
      </div>
    </div>
  )
}

export function StemDeckPanel({
  snapshot,
  onMute,
  onSolo,
  onGain,
  onPan,
  onLearn,
}: {
  snapshot: EngineSnapshot
  onMute: (stemId: string) => void
  onSolo: (stemId: string) => void
  onGain: (stemId: string, gain: number) => void
  onPan: (stemId: string, pan: number) => void
  onLearn?: (target: 'stem_mute' | 'stem_solo' | 'stem_volume', stemId: string) => void
}) {
  if (snapshot.stems.length === 0) {
    return <div className="empty">No stems loaded for the current song. Start a song with stems, or add stems in the workspace.</div>
  }
  return (
    <div className="stem-deck">
      {snapshot.stems.map((stem) => (
        <div key={stem.id} className={`stem${stem.muted ? ' muted' : ''}${stem.solo ? ' solo' : ''}`}>
          <div className="stem-name">
            <span className="stem-type">{stem.stemType.toUpperCase()}</span>
            {stem.label !== stem.stemType && <span className="faint"> {stem.label}</span>}
            <span className="stem-meter">
              <span className="stem-meter-fill" style={{ width: `${Math.round(Math.min(1, stem.level) * 100)}%` }} />
            </span>
          </div>
          <div className="stem-controls">
            <button className={`small${stem.muted ? ' danger' : ''}`} onClick={() => onMute(stem.id)}>
              M
            </button>
            <button className={`small${stem.solo ? ' ok' : ''}`} onClick={() => onSolo(stem.id)}>
              S
            </button>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={stem.gain}
              onChange={(event) => onGain(stem.id, Number(event.target.value))}
              title={`gain ${stem.gain.toFixed(2)}`}
            />
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={stem.pan}
              onChange={(event) => onPan(stem.id, Number(event.target.value))}
              className="pan"
              title={`pan ${stem.pan.toFixed(2)}`}
            />
            {onLearn && (
              <button className="small faint" onClick={() => onLearn('stem_volume', stem.id)} title="MIDI Learn: volume">
                learn
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
