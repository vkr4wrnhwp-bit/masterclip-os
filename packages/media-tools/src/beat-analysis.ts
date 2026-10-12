import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError } from '@masterclip/shared'
import { probe } from './probe.js'
import { ffmpegPaths } from './runner.js'

const execFileAsync = promisify(execFile)
const RATE = 4000
const HOP = 200 // energy envelope: 20 frames per second
const MAX_DURATION = 600

export interface BeatAnalysis {
  bpm: number | null
  confidence: number
  beats: number[]
  durationSeconds: number
  source: 'decoded_pcm_onset'
  analysisVersion: 1
  limitation: string
}

/** Extract mono PCM safely; decoded samples never enter a command shell. */
export async function beatAnalysis(path: string): Promise<BeatAnalysis> {
  const info = await probe(path)
  if (!info.audio || !(info.durationSeconds > 0) || info.durationSeconds > MAX_DURATION) {
    throw new AppError({ kind: 'validation', code: 'beats.invalid_audio', message: 'beat analysis requires audio lasting no more than ten minutes' })
  }
  const decoded = await execFileAsync(ffmpegPaths().ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1',
  ], { encoding: 'buffer', timeout: 120_000, maxBuffer: 6 * 1024 * 1024, windowsHide: true })
  const pcm = Buffer.isBuffer(decoded.stdout) ? decoded.stdout : Buffer.from(decoded.stdout)
  const samples = Math.floor(pcm.byteLength / 2)
  if (samples < RATE * 2) {
    throw new AppError({ kind: 'validation', code: 'beats.short_audio', message: 'two seconds of decoded audio required' })
  }
  const energies: number[] = []
  for (let i = 0; i + HOP <= samples; i += HOP) {
    let squared = 0
    for (let j = 0; j < HOP; j++) {
      const v = pcm.readInt16LE((i + j) * 2) / 32768
      squared += v * v
    }
    energies.push(Math.sqrt(squared / HOP))
  }
  return analyzeOnsetEnvelope(energies, HOP / RATE, info.durationSeconds)
}

/** Pure DSP stage, separately tested. Detect onset strength, periodicity and
 * phase. Conservative confidence prevents pretending sustained/silent sources
 * have reliable tempo. Does not claim downbeats, meter or song sections.
 */
export function analyzeOnsetEnvelope(energies: readonly number[], stepSeconds: number, durationSeconds: number): BeatAnalysis {
  const empty = (): BeatAnalysis => ({
    bpm: null, confidence: 0, beats: [], durationSeconds, source: 'decoded_pcm_onset', analysisVersion: 1,
    limitation: 'Tempo and beat positions are estimates; verify by ear. No meter, downbeat or section detection.',
  })
  if (!energies.length || !(stepSeconds > 0) || !(durationSeconds > 0)) return empty()
  const maxEnergy = Math.max(...energies)
  if (maxEnergy < 0.001) return empty()
  const onset: number[] = []
  for (let i = 0; i < energies.length; i++) {
    const previous = i ? energies[i - 1]! : energies[i]!
    onset.push(Math.max(0, energies[i]! - previous))
  }
  const peak = Math.max(...onset)
  const count = onset.filter(value => value > peak * 0.25).length
  if (peak < 0.001 || count < 4) return empty()
  const maxLag = Math.min(onset.length - 1, Math.round(60 / (60 * stepSeconds)))
  const minLag = Math.max(2, Math.round(60 / (180 * stepSeconds)))
  let best = { lag: 0, score: 0 }
  let sumScores = 0
  let candidates = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0, aa = 0, bb = 0
    for (let i = lag; i < onset.length; i++) {
      const a = onset[i]!
      const b = onset[i - lag]!
      dot += a * b
      aa += a * a
      bb += b * b
    }
    const correlation = dot / (Math.sqrt(aa * bb) + 1e-12)
    if (correlation > best.score) best = { lag, score: correlation }
    sumScores += correlation
    candidates++
  }
  const meanScore = candidates ? sumScores / candidates : 0
  const prominence = Math.max(0, best.score - meanScore)
  const confidence = Number(Math.min(1, Math.max(0, prominence * 1.8 + (best.score - 0.5) * 0.4)).toFixed(3))
  if (best.lag === 0 || confidence < 0.17) return empty()
  const interval = best.lag * stepSeconds
  const bpm = Math.round(60 / interval * 10) / 10
  let phaseIndex = 0, phaseScore = -1
  for (let phase = 0; phase < best.lag; phase++) {
    let score = 0
    for (let i = phase; i < onset.length; i += best.lag) score += onset[i]!
    if (score > phaseScore) { phaseScore = score; phaseIndex = phase }
  }
  const beats: number[] = []
  for (let t = phaseIndex * stepSeconds; t <= durationSeconds && beats.length < 1500; t += interval) {
    beats.push(Number(t.toFixed(3)))
  }
  return { ...empty(), bpm, confidence, beats }
}
