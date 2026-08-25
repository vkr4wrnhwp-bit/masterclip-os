import type { PackageFileStore } from '@masterclip/performance-project'

/**
 * Local performance cache.
 *
 * A CacheStore holds the bytes of one performance package. The browser uses
 * IndexedDB; tests use memory; the desktop build will use the filesystem.
 * All of them satisfy PackageFileStore, so package verification runs
 * identically everywhere.
 */

export interface CacheStore extends PackageFileStore {
  put(path: string, bytes: Uint8Array): Promise<void>
  get(path: string): Promise<Uint8Array | null>
  delete(path: string): Promise<void>
  listPaths(): Promise<string[]>
  clear(): Promise<void>
  totalBytes(): Promise<number>
}

/** SHA-256 hex via WebCrypto — the same code path in Node 22 and the browser. */
export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type AudioDecodeCheck = (bytes: Uint8Array) => Promise<boolean>

/** Default decode check: a WAV/RIFF header sanity pass, no full decoder needed. */
export const headerDecodeCheck: AudioDecodeCheck = async (bytes) => {
  if (bytes.length < 44) return false
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return true
  if (ascii(0, 3) === 'ID3') return true
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return true // MPEG frame sync
  if (ascii(4, 4) === 'ftyp') return true // MP4/AAC container
  if (ascii(0, 4) === 'OggS') return true
  if (ascii(0, 4) === 'fLaC') return true
  return false
}

export class MemoryCacheStore implements CacheStore {
  private readonly files = new Map<string, Uint8Array>()

  constructor(private readonly decodeCheck: AudioDecodeCheck = headerDecodeCheck) {}

  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(bytes))
  }

  async get(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path)
  }

  async listPaths(): Promise<string[]> {
    return [...this.files.keys()]
  }

  async clear(): Promise<void> {
    this.files.clear()
  }

  async totalBytes(): Promise<number> {
    let total = 0
    for (const bytes of this.files.values()) total += bytes.length
    return total
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async bytes(path: string): Promise<number> {
    return this.files.get(path)?.length ?? 0
  }

  async sha256(path: string): Promise<string> {
    const bytes = this.files.get(path)
    if (!bytes) return ''
    return sha256HexOf(bytes)
  }

  async decodable(path: string): Promise<boolean> {
    const bytes = this.files.get(path)
    if (!bytes) return false
    return this.decodeCheck(bytes)
  }
}
