/** Human listening observations, not calibrated device measurements. */
export const LISTENING_DEVICES = ['phone', 'headphones', 'car', 'mono'] as const
export type ListeningDevice = typeof LISTENING_DEVICES[number]
export interface ListeningNote {
  device: ListeningDevice
  checked: boolean
  note: string
}
export interface VersionListeningNotes {
  orgId: string
  songId: string
  versionId: string
  notes: ListeningNote[]
}
export interface TranslationMeasurement {
  name: 'truePeak' | 'monoCorrelation' | 'lowEndShare'
  value: number | null
  sourceFile: string
  analyzerVersion: string
}
export function validateListeningNotes(record: VersionListeningNotes): VersionListeningNotes {
  if (!record.orgId || !record.songId || !record.versionId) throw new Error('An exact song version is required.')
  if (record.notes.length !== LISTENING_DEVICES.length ||
      new Set(record.notes.map(x => x.device)).size !== LISTENING_DEVICES.length ||
      record.notes.some(x => !LISTENING_DEVICES.includes(x.device) || typeof x.checked !== 'boolean' ||
        typeof x.note !== 'string' || x.note.length > 400))
    throw new Error('Provide one checked state and a short note for each listening device.')
  return { ...record, notes: record.notes.map(note => ({ ...note })) }
}
export function blankListeningNotes(orgId: string, songId: string, versionId: string): VersionListeningNotes {
  return validateListeningNotes({ orgId, songId, versionId,
    notes: LISTENING_DEVICES.map(device => ({ device, checked: false, note: '' })) })
}
export function translationEvidence(metrics: readonly TranslationMeasurement[]) {
  const expected = [
    ['truePeak', 'True peak'],
    ['monoCorrelation', 'Mono compatibility / stereo correlation'],
    ['lowEndShare', 'Low-end share below about 60 Hz'],
  ] as const
  return expected.map(([key, label]) => {
    const source = metrics.find(x => x.name === key)
    return {
      name: label,
      value: source?.value == null || !Number.isFinite(source.value) ? null : source.value,
      source: source ? `${source.sourceFile}; analyzer ${source.analyzerVersion}` : '',
      explanation: source?.value == null || !Number.isFinite(source.value)
        ? 'Not enough information: this measurement is not available.' : '',
    }
  })
}
