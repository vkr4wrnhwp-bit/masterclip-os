import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib'

/**
 * A small ZIP writer for the backup export (routes/backup-export.ts).
 *
 * Writes straight to a file on disk, one entry at a time, streaming each
 * source file through (deflated, or stored as it is for media that is already
 * compressed), so a backup of hundreds of megabytes never sits in memory on a
 * 512 MB instance. No dependency: the format is a local header per entry, the
 * data, then a central directory (PKWARE APPNOTE 4.3), and node:zlib has both
 * the deflate and the CRC-32.
 *
 * No ZIP64: an archive or entry past 4 GB, or more than 65,535 entries, is
 * refused rather than written wrong. The export's own cap (500 MB by default)
 * keeps far inside that.
 */
const LIMIT_32 = 0xffffffff
export const MAX_ZIP_ENTRIES = 65535

interface Entry {
  name: Buffer
  method: 0 | 8
  crc: number
  compressed: number
  size: number
  offset: number
  time: number
  date: number
}

export class ZipTooLarge extends Error {}

function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getUTCFullYear())
  return {
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | Math.floor(when.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  }
}

export class ZipWriter {
  private offset = 0
  private readonly entries: Entry[] = []
  private closed = false

  private constructor(private readonly fh: FileHandle, private readonly when: Date) {}

  static async create(path: string, when: Date = new Date()): Promise<ZipWriter> {
    return new ZipWriter(await open(path, 'w'), when)
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.offset
  }

  get count(): number {
    return this.entries.length
  }

  private async writeAt(data: Buffer, position: number): Promise<void> {
    let done = 0
    while (done < data.length) {
      const { bytesWritten } = await this.fh.write(data, done, data.length - done, position + done)
      done += bytesWritten
    }
  }

  private localHeader(e: Entry): Buffer {
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(0x0800, 6) // names are UTF-8
    h.writeUInt16LE(e.method, 8)
    h.writeUInt16LE(e.time, 10)
    h.writeUInt16LE(e.date, 12)
    h.writeUInt32LE(e.crc >>> 0, 14)
    h.writeUInt32LE(e.compressed, 18)
    h.writeUInt32LE(e.size, 22)
    h.writeUInt16LE(e.name.length, 26)
    h.writeUInt16LE(0, 28)
    return Buffer.concat([h, e.name])
  }

  private begin(name: string, method: 0 | 8): Entry {
    if (this.closed) throw new Error('zip already closed')
    if (this.entries.length >= MAX_ZIP_ENTRIES) throw new ZipTooLarge('too many entries for a zip without ZIP64')
    const { time, date } = dosStamp(this.when)
    return { name: Buffer.from(name, 'utf8'), method, crc: 0, compressed: 0, size: 0, offset: this.offset, time, date }
  }

  private async finish(e: Entry, dataEnd: number): Promise<void> {
    if (e.size > LIMIT_32 || e.compressed > LIMIT_32 || dataEnd > LIMIT_32) throw new ZipTooLarge('past 4 GB, which needs ZIP64')
    await this.writeAt(this.localHeader(e), e.offset)
    this.offset = dataEnd
    this.entries.push(e)
  }

  /** One entry from bytes in memory (the manifest, the file list). */
  async addBuffer(name: string, data: Buffer, deflate = true): Promise<void> {
    const e = this.begin(name, deflate ? 8 : 0)
    const body = deflate ? deflateRawSync(data) : data
    e.crc = crc32(data)
    e.size = data.length
    e.compressed = body.length
    const start = e.offset + 30 + e.name.length
    await this.writeAt(body, start)
    await this.finish(e, start + body.length)
  }

  /** One entry streamed from a file on disk. */
  async addFile(name: string, sourcePath: string, deflate: boolean): Promise<void> {
    const e = this.begin(name, deflate ? 8 : 0)
    let position = e.offset + 30 + e.name.length
    let crc = 0
    let size = 0
    let compressed = 0
    const tap = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        crc = crc32(chunk, crc)
        size += chunk.length
        yield chunk
      }
    }
    const sink = async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        await this.writeAt(chunk, position)
        position += chunk.length
        compressed += chunk.length
        if (position > LIMIT_32) throw new ZipTooLarge('past 4 GB, which needs ZIP64')
      }
    }
    if (deflate) await pipeline(createReadStream(sourcePath), tap, createDeflateRaw(), sink)
    else await pipeline(createReadStream(sourcePath), tap, sink)
    e.crc = crc
    e.size = size
    e.compressed = compressed
    await this.finish(e, position)
  }

  /** Writes the central directory and closes the file. */
  async close(): Promise<void> {
    if (this.closed) return
    const start = this.offset
    const parts: Buffer[] = []
    for (const e of this.entries) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4)
      c.writeUInt16LE(20, 6)
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(e.method, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc >>> 0, 16)
      c.writeUInt32LE(e.compressed, 20)
      c.writeUInt32LE(e.size, 24)
      c.writeUInt16LE(e.name.length, 28)
      // extra 30, comment 32, disk 34, internal attributes 36, external 38: all zero
      c.writeUInt32LE(e.offset, 42)
      parts.push(c, e.name)
    }
    const directory = Buffer.concat(parts)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(start, 16)
    if (start + directory.length + end.length > LIMIT_32) throw new ZipTooLarge('past 4 GB, which needs ZIP64')
    await this.writeAt(Buffer.concat([directory, end]), start)
    this.offset = start + directory.length + end.length
    this.closed = true
    await this.fh.close()
  }

  /** Closes the file without finishing it (after a failure). */
  async abandon(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.fh.close().catch(() => undefined)
  }
}
