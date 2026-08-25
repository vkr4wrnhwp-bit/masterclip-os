import { headerDecodeCheck, sha256HexOf, type AudioDecodeCheck, type CacheStore } from './store.js'

/**
 * IndexedDB-backed cache. One database per performance package, holding raw
 * audio bytes keyed by package path. IndexedDB rather than the Cache API
 * because we need byte-level access for checksumming and decoding, not
 * request/response semantics.
 */
export class IndexedDbCacheStore implements CacheStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly decodeCheck: AudioDecodeCheck,
  ) {}

  static async open(name: string, decodeCheck: AudioDecodeCheck = headerDecodeCheck): Promise<IndexedDbCacheStore> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`livelab-package-${name}`, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'))
    })
    return new IndexedDbCacheStore(db, decodeCheck)
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction('files', mode).objectStore('files')
  }

  private request<T>(build: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = 'readonly'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = build(this.tx(mode))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'))
    })
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    await this.request((store) => store.put(bytes, path), 'readwrite')
  }

  async get(path: string): Promise<Uint8Array | null> {
    const value = await this.request<unknown>((store) => store.get(path))
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return null
  }

  async delete(path: string): Promise<void> {
    await this.request((store) => store.delete(path), 'readwrite')
  }

  async listPaths(): Promise<string[]> {
    const keys = await this.request<IDBValidKey[]>((store) => store.getAllKeys())
    return keys.map(String)
  }

  async clear(): Promise<void> {
    await this.request((store) => store.clear(), 'readwrite')
  }

  async totalBytes(): Promise<number> {
    const paths = await this.listPaths()
    let total = 0
    for (const path of paths) total += await this.bytes(path)
    return total
  }

  async exists(path: string): Promise<boolean> {
    return (await this.get(path)) !== null
  }

  async bytes(path: string): Promise<number> {
    return (await this.get(path))?.length ?? 0
  }

  async sha256(path: string): Promise<string> {
    const bytes = await this.get(path)
    if (!bytes) return ''
    return sha256HexOf(bytes)
  }

  async decodable(path: string): Promise<boolean> {
    const bytes = await this.get(path)
    if (!bytes) return false
    return this.decodeCheck(bytes)
  }

  close(): void {
    this.db.close()
  }
}

/** Bytes the browser will likely allow us to store. Best-effort; may be absent. */
export async function estimateAvailableStorageBytes(): Promise<number | undefined> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate()
      if (quota !== undefined) return Math.max(0, quota - (usage ?? 0))
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Asks the browser to stop treating this origin's storage as evictable.
 *
 * Without it, a verified show cache is best-effort: the browser may reclaim it
 * under storage pressure, and the first anyone would know is a pad reading
 * ERROR at the venue. Granting is the browser's call — Chromium generally says
 * yes to an installed or engaged origin, Safari applies its own rules — so this
 * reports what happened rather than pretending the cache is now safe.
 *
 * Returns the resulting persisted state, or undefined where the API is absent.
 */
export async function requestPersistentStorage(): Promise<boolean | undefined> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return undefined
    // Already granted: asking again would prompt some browsers for nothing.
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true
    return await navigator.storage.persist()
  } catch {
    return undefined
  }
}
