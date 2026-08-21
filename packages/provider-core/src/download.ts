import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppError, classifyStatus, sha256File, withRetry } from '@masterclip/shared'
import type { CompletedJob, DownloadedAsset, ProviderOutputRef } from './types.js'

const EXTENSION_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'audio/wav': 'wav',
}

/**
 * Shared output downloader.
 *
 * Every adapter uses this so provider outputs are fetched, retried, hashed, and
 * size-verified identically. A zero-byte or truncated download must never reach
 * QC looking like a creative failure — it is an I/O failure and is reported as
 * one.
 */
export async function downloadProviderOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
  await mkdir(destDir, { recursive: true })
  const assets: DownloadedAsset[] = []
  for (const output of job.outputs) {
    assets.push(await downloadOne(job.externalJobId, output, destDir))
  }
  return assets
}

async function downloadOne(jobId: string, output: ProviderOutputRef, destDir: string): Promise<DownloadedAsset> {
  const extension = EXTENSION_BY_MIME[output.mime.split(';')[0]?.trim() ?? ''] ?? 'bin'
  const safeJobId = jobId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const destPath = join(destDir, `${safeJobId}_${output.index}.${extension}`)

  const bytes = await withRetry(
    async () => {
      const response = await fetch(output.url, { headers: output.headers ?? {} })
      if (!response.ok || !response.body) {
        throw new AppError({
          kind: classifyStatus(response.status),
          code: `download.${response.status}`,
          message: `output download failed with status ${response.status}`,
          details: { index: output.index },
        })
      }
      await mkdir(dirname(destPath), { recursive: true })
      const sink = createWriteStream(destPath)
      const reader = response.body.getReader()
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          total += value.byteLength
          if (!sink.write(value)) await new Promise<void>((resolve) => sink.once('drain', () => resolve()))
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          sink.end(() => resolve())
          sink.on('error', reject)
        })
      }
      if (total === 0) {
        throw new AppError({ kind: 'io', code: 'download.empty', message: 'provider returned a zero-byte output' })
      }
      // Trust the provider's declared size when it gives one: a short read is a
      // truncated file that would otherwise be graded as a bad render.
      if (output.bytes && total !== output.bytes) {
        throw new AppError({
          kind: 'io',
          code: 'download.size_mismatch',
          message: `downloaded ${total} bytes, provider declared ${output.bytes}`,
        })
      }
      return total
    },
    { maxAttempts: 4, baseMs: 500 },
  )

  const info = await stat(destPath)
  return {
    localPath: destPath,
    bytes: info.size === bytes ? info.size : bytes,
    sha256: await sha256File(destPath),
    mime: output.mime,
    index: output.index,
  }
}
