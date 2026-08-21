import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { S3Storage, downloadToFile } from '../src/index.js'
import { startS3TestServer, type S3TestServer } from './s3-server.js'

/**
 * The S3 driver over a real socket.
 *
 * Until now this driver had never made an HTTP request in any test — the SigV4
 * signer was verified against AWS's published vector, but everything around it
 * (URL construction, key encoding, XML parsing, status mapping, presign
 * fetchability) was unexercised. This closes that half.
 *
 * It does not close the other half: the server here expects S3, but it is not
 * AWS. Risk #12 stays open until a real bucket is used.
 */
const BUCKET = 'masterclip-test'
// AWS's own published example credentials, the same pair their SigV4 test
// vectors use. Not a secret. lint-allow-secret-fixture
const CREDENTIALS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } // lint-allow-secret-fixture

let server: S3TestServer
let storage: S3Storage
let scratch: string

beforeEach(async () => {
  server = await startS3TestServer(BUCKET)
  scratch = await mkdtemp(join(tmpdir(), 'masterclip-s3-test-'))
  storage = new S3Storage({
    endpoint: server.endpoint,
    bucket: BUCKET,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    now: () => 1_800_000_000_000,
  })
})

afterEach(async () => {
  await server.close()
  await rm(scratch, { recursive: true, force: true })
})

describe('S3 driver over HTTP', () => {
  it('round-trips a buffer', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const stored = await storage.putBuffer('proj/a/clip.mp4', data, { contentType: 'video/mp4' })
    expect(stored.bytes).toBe(5)
    expect(await storage.getBuffer('proj/a/clip.mp4')).toEqual(data)
  })

  it('signs the body it actually sends', async () => {
    // The server hashes the bytes that arrived and compares them to the
    // driver's declared x-amz-content-sha256. A mismatch is a 400, so this
    // passing means the signed payload hash describes the real payload.
    const big = new Uint8Array(200_000).map((_, i) => i % 251)
    await storage.putBuffer('proj/a/big.bin', big)
    expect(await storage.getBuffer('proj/a/big.bin')).toEqual(big)
  })

  it('emits a well-formed SigV4 Authorization header', async () => {
    await storage.putBuffer('proj/a/one.bin', new Uint8Array([1]))
    const put = server.requests.find((r) => r.method === 'PUT')
    expect(put?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, /) // lint-allow-secret-fixture
    expect(put?.auth).toMatch(/SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/)
  })

  it('puts a file from disk', async () => {
    const source = join(scratch, 'source.bin')
    await writeFile(source, Buffer.from('on disk'))
    const stored = await storage.putFile('proj/a/from-disk.bin', source)
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(await storage.getBuffer('proj/a/from-disk.bin')).toString()).toBe('on disk')
  })

  it('materializes an object to a local path', async () => {
    await storage.putBuffer('proj/a/clip.mp4', new Uint8Array([9, 9, 9]))
    const dest = join(scratch, 'nested', 'out.mp4')
    await storage.materialize('proj/a/clip.mp4', dest)
    expect([...(await readFile(dest))]).toEqual([9, 9, 9])
  })

  it('reports existence without downloading', async () => {
    await storage.putBuffer('proj/a/here.bin', new Uint8Array([1]))
    expect(await storage.exists('proj/a/here.bin')).toBe(true)
    expect(await storage.exists('proj/a/absent.bin')).toBe(false)
    expect(server.requests.some((r) => r.method === 'HEAD')).toBe(true)
  })

  it('deletes', async () => {
    await storage.putBuffer('proj/a/gone.bin', new Uint8Array([1]))
    await storage.delete('proj/a/gone.bin')
    expect(await storage.exists('proj/a/gone.bin')).toBe(false)
  })

  it('lists by prefix and parses the response XML', async () => {
    await storage.putBuffer('proj/a/one.bin', new Uint8Array([1]))
    await storage.putBuffer('proj/a/two.bin', new Uint8Array([2]))
    await storage.putBuffer('proj/b/three.bin', new Uint8Array([3]))
    expect(await storage.list('proj/a/')).toEqual(['proj/a/one.bin', 'proj/a/two.bin'])
  })

  it('survives keys that need escaping', async () => {
    // Filenames reach object keys after sanitisation, but the encoding still
    // has to survive the round trip or the object is written somewhere else.
    const key = 'proj/a/take 2 (final).mp4'
    await storage.putBuffer(key, new Uint8Array([7]))
    expect([...(await storage.getBuffer(key))]).toEqual([7])
    expect(await storage.list('proj/a/')).toContain(key)
  })

  it('reports a missing object as not_found rather than a generic failure', async () => {
    await expect(storage.getBuffer('proj/a/never-existed.bin')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('maps a server failure onto the error taxonomy', async () => {
    server.failNextWith(500)
    await expect(storage.putBuffer('proj/a/x.bin', new Uint8Array([1]))).rejects.toMatchObject({ code: 's3.500' })
  })

  it('produces a presigned URL that actually fetches without credentials', async () => {
    await storage.putBuffer('proj/a/signed.mp4', new Uint8Array([4, 2]))
    const url = await storage.signedUrl('proj/a/signed.mp4', 3600)

    const dest = join(scratch, 'signed.mp4')
    const bytes = await downloadToFile(url, dest)
    expect(bytes).toBe(2)
    expect([...(await readFile(dest))]).toEqual([4, 2])

    // It must carry its authorization in the query string, not a header.
    const presigned = server.requests.at(-1)
    expect(presigned?.auth).toBeUndefined()
    expect(presigned?.query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(presigned?.query.get('X-Amz-Expires')).toBe('3600')
  })
})
