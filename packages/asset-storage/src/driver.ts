export interface StoredObject {
  key: string
  bytes: number
  sha256: string
  contentType: string
}

export interface PutOptions {
  contentType?: string
  /** Provided when already known, so a large file is not hashed twice. */
  sha256?: string
}

export interface StorageDriver {
  readonly name: 'local' | 's3'
  putFile(key: string, sourcePath: string, opts?: PutOptions): Promise<StoredObject>
  putBuffer(key: string, data: Uint8Array, opts?: PutOptions): Promise<StoredObject>
  getBuffer(key: string): Promise<Uint8Array>
  /**
   * Local filesystem path for the object, or null when the driver has none.
   * ffmpeg works on paths; remote drivers must be staged to disk first.
   */
  localPath(key: string): string | null
  /** Materialises the object on local disk and returns the path. */
  materialize(key: string, destPath: string): Promise<string>
  exists(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  /** Time-limited, tamper-evident URL. Never a raw public path. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>
  list(prefix: string): Promise<string[]>
}

/**
 * Object keys are built here, never from user input, so a filename can never
 * escape its project prefix.
 */
export function objectKey(parts: {
  projectId: string
  kind: string
  id: string
  filename: string
}): string {
  return [sanitizeSegment(parts.projectId), sanitizeSegment(parts.kind), sanitizeSegment(parts.id), sanitizeFilename(parts.filename)].join(
    '/',
  )
}

export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 96) : 'unnamed'
}

/**
 * Filenames arrive from uploads and from provider downloads. Strip directory
 * separators, traversal, and leading dots before the value ever reaches a path
 * join or a shell-adjacent API.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'file'
}

/** Extension inferred from a MIME type, for keys built from provider downloads. */
export function extensionForMime(mime: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'application/json': 'json',
    'text/csv': 'csv',
  }
  return map[mime.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'bin'
}
