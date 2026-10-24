import React from 'react'
import { request } from './api.js'

type Device = 'phone' | 'headphones' | 'car' | 'mono'
type Note = { device: Device; checked: boolean; note: string }
const DEVICES: Device[] = ['phone', 'headphones', 'car', 'mono']
const LABELS: Record<Device, string> = { phone: 'Phone', headphones: 'Headphones', car: 'Car', mono: 'Mono' }

export function TranslationNotes({ linkId, versionId }: { linkId: string; versionId: string }) {
  const [notes, setNotes] = React.useState<Note[]>([])
  const [error, setError] = React.useState('')
  const [saving, setSaving] = React.useState<Device | null>(null)
  const base = `/api/song-journey/links/${encodeURIComponent(linkId)}/versions/${encodeURIComponent(versionId)}/translation-notes`
  React.useEffect(() => {
    let active = true
    setNotes([])
    request<{ notes: Array<{device:Device; checked:number|boolean; note:string}> }>(base)
      .then(result => { if (active) setNotes(DEVICES.map(device => {
        const entry = result.notes.find(note => note.device === device)
        return { device, checked: !!entry?.checked, note: entry?.note ?? '' }
      })) })
      .catch(() => { if (active) setError('Could not load notes for this version.') })
    return () => { active = false }
  }, [base])
  const save = async (note: Note) => {
    setSaving(note.device); setError('')
    try { await request(base, { method: 'PUT', body: JSON.stringify(note) }) }
    catch { setError('Could not save this note. Your previous saved note is unchanged.') }
    finally { setSaving(null) }
  }
  return <section className="sl-translation-notes" aria-label="Translation listening notes">
    <h3>Your own listening notes</h3>
    <p>These ticks are your notes, not a device test. Notes stay with the exact version you chose.</p>
    {error && <p role="alert">{error}</p>}
    <div className="sl-listening-grid">{notes.map(item => <div className="sl-listening-device" key={item.device}>
      <label><input type="checkbox" checked={item.checked} onChange={event => {
        const changed = { ...item, checked: event.target.checked }
        setNotes(old => old.map(n => n.device === item.device ? changed : n))
        void save(changed)
      }} />{LABELS[item.device]}</label>
      <textarea aria-label={`${LABELS[item.device]} listening note`} maxLength={500} value={item.note}
        onChange={event => setNotes(old => old.map(n => n.device === item.device ? { ...n, note: event.target.value } : n))} />
      <button type="button" disabled={saving === item.device} onClick={() => void save(item)}>{saving === item.device ? 'Saving…' : 'Save note'}</button>
    </div>)}</div>
  </section>
}
