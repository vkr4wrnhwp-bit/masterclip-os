/**
 * Signal-processing primitives.
 *
 * Deliberately small and dependency-free: an in-place radix-2 FFT, a Hann
 * window, and the handful of spectral descriptors the rest of the module needs.
 * Everything is deterministic, so the same file analysed twice produces the
 * same feature vector — which is what makes version-to-version comparison and
 * cached analysis meaningful.
 */

/** In-place iterative radix-2 Cooley–Tukey FFT. `real`/`imag` must be 2^k long. */
export function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`)

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j]!, real[i]!]
      ;[imag[i], imag[j]] = [imag[j]!, imag[i]!]
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wReal = Math.cos(angle)
    const wImag = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curReal = 1
      let curImag = 0
      for (let j = 0; j < len / 2; j++) {
        const aReal = real[i + j]!
        const aImag = imag[i + j]!
        const bReal = real[i + j + len / 2]! * curReal - imag[i + j + len / 2]! * curImag
        const bImag = real[i + j + len / 2]! * curImag + imag[i + j + len / 2]! * curReal
        real[i + j] = aReal + bReal
        imag[i + j] = aImag + bImag
        real[i + j + len / 2] = aReal - bReal
        imag[i + j + len / 2] = aImag - bImag
        const nextReal = curReal * wReal - curImag * wImag
        curImag = curReal * wImag + curImag * wReal
        curReal = nextReal
      }
    }
  }
}

const WINDOW_CACHE = new Map<number, Float64Array>()

export function hannWindow(size: number): Float64Array {
  const cached = WINDOW_CACHE.get(size)
  if (cached) return cached
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  WINDOW_CACHE.set(size, window)
  return window
}

/** Magnitude spectrum of one windowed frame. Returns `size/2` bins. */
export function magnitudeSpectrum(samples: Float32Array, offset: number, size: number): Float64Array {
  const window = hannWindow(size)
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    real[i] = (samples[offset + i] ?? 0) * window[i]!
  }
  fft(real, imag)
  const bins = size >> 1
  const magnitudes = new Float64Array(bins)
  for (let i = 0; i < bins; i++) magnitudes[i] = Math.hypot(real[i]!, imag[i]!)
  return magnitudes
}

/** Energy-weighted mean bin, as a fraction of Nyquist. 0 when the frame is silent. */
export function spectralCentroid(magnitudes: Float64Array): number {
  let weighted = 0
  let total = 0
  for (let i = 0; i < magnitudes.length; i++) {
    weighted += i * magnitudes[i]!
    total += magnitudes[i]!
  }
  return total > 0 ? weighted / total / magnitudes.length : 0
}

/**
 * Spectral flatness (geometric ÷ arithmetic mean). Near 1 for noise-like
 * frames, near 0 for strongly tonal ones — the cheapest reliable proxy for
 * "how much is going on" that does not need source separation.
 */
export function spectralFlatness(magnitudes: Float64Array): number {
  let logSum = 0
  let sum = 0
  let counted = 0
  for (const magnitude of magnitudes) {
    const value = magnitude + 1e-10
    logSum += Math.log(value)
    sum += value
    counted++
  }
  if (counted === 0 || sum <= 0) return 0
  const geometric = Math.exp(logSum / counted)
  const arithmetic = sum / counted
  return arithmetic > 0 ? Math.min(1, geometric / arithmetic) : 0
}

/** Fraction of total energy below `cutoffRatio` of Nyquist. */
export function bandEnergyRatio(magnitudes: Float64Array, lowRatio: number, highRatio: number): number {
  const from = Math.max(0, Math.floor(lowRatio * magnitudes.length))
  const to = Math.min(magnitudes.length, Math.ceil(highRatio * magnitudes.length))
  let band = 0
  let total = 0
  for (let i = 0; i < magnitudes.length; i++) {
    const energy = magnitudes[i]! * magnitudes[i]!
    total += energy
    if (i >= from && i < to) band += energy
  }
  return total > 0 ? band / total : 0
}

/**
 * Half-wave-rectified spectral flux between consecutive frames — the standard
 * onset-strength function. Only increases count, because an instrument
 * stopping is not an onset.
 */
export function spectralFlux(previous: Float64Array, current: Float64Array): number {
  let flux = 0
  for (let i = 0; i < current.length; i++) {
    const delta = current[i]! - (previous[i] ?? 0)
    if (delta > 0) flux += delta
  }
  return flux
}

/** Bin index → frequency in Hz. */
export function binFrequency(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]!
  return sum / values.length
}

export function standardDeviation(values: ArrayLike<number>): number {
  if (values.length < 2) return 0
  const average = mean(values)
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += (values[i]! - average) ** 2
  return Math.sqrt(sum / (values.length - 1))
}

/** Rescales to 0–1 against the observed range. Flat input maps to 0.5. */
export function normalize(values: number[]): number[] {
  if (values.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) return values.map(() => 0.5)
  return values.map((value) => (value - min) / (max - min))
}

/** Moving average. Used to take the jitter off onset and energy curves. */
export function smooth(values: number[], radius: number): number[] {
  if (radius <= 0) return [...values]
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius)
    const to = Math.min(values.length - 1, i + radius)
    let sum = 0
    for (let j = from; j <= to; j++) sum += values[j]!
    out[i] = sum / (to - from + 1)
  }
  return out
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
