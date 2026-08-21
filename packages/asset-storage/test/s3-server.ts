import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { AddressInfo } from 'node:net'

/**
 * A minimal S3-compatible server, for exercising the real driver over a real
 * socket.
 *
 * The SigV4 *signer* is already covered by a unit test against AWS's published
 * test vector, so what has never been tested is everything around it: how the
 * driver builds path-style URLs, encodes keys, assembles headers, parses the
 * list XML, maps status codes to error kinds, and whether a presigned URL is
 * actually fetchable. Those need a server on the other end of a socket, and a
 * faithful one is about a hundred lines.
 *
 * Written here rather than pulled from npm because the only candidate
 * (`s3rver`) has been unmaintained since 2022, and this codebase deliberately
 * hand-rolls small pieces rather than take a dependency for them.
 *
 * It is NOT a compatibility oracle. Passing this proves the driver speaks
 * well-formed S3 to something that expects S3 — not that AWS agrees. Risk #12
 * stays open until a real bucket is used.
 */
export interface S3TestServer {
  endpoint: string
  /** Every request the server saw, for asserting on what the driver actually sent. */
  requests: Array<{ method: string; path: string; auth: string | undefined; query: URLSearchParams }>
  objects: Map<string, { body: Buffer; contentType: string }>
  /** Forces the next request to fail with this status, to test error mapping. */
  failNextWith: (status: number) => void
  close: () => Promise<void>
}

const AUTH_PATTERN =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/

export async function startS3TestServer(bucket: string): Promise<S3TestServer> {
  const objects = new Map<string, { body: Buffer; contentType: string }>()
  const requests: S3TestServer['requests'] = []
  let failNext: number | null = null

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://localhost')
      const auth = req.headers.authorization
      requests.push({ method: req.method ?? '', path: url.pathname, auth, query: url.searchParams })

      if (failNext !== null) {
        const status = failNext
        failNext = null
        res.writeHead(status, { 'content-type': 'application/xml' })
        res.end('<Error><Code>InternalError</Code><Message>injected</Message></Error>')
        return
      }

      const presigned = url.searchParams.has('X-Amz-Signature')
      if (!presigned) {
        // Structural check only — the signature itself is verified against AWS's
        // own test vector elsewhere. What matters here is that the driver emits
        // a well-formed header at all.
        if (!auth || !AUTH_PATTERN.test(auth)) {
          return reject(res, 403, 'AccessDenied', `malformed or missing Authorization: ${auth ?? '(none)'}`)
        }
        // This one is a real, independent check: the driver declares a payload
        // hash, and we hash the bytes that actually arrived. A mismatch means
        // the body was encoded or truncated differently than it was signed.
        const declared = req.headers['x-amz-content-sha256']
        const actual = createHash('sha256').update(body).digest('hex')
        if (typeof declared === 'string' && declared !== actual) {
          return reject(res, 400, 'XAmzContentSHA256Mismatch', `declared ${declared} but received ${actual}`)
        }
        if (!req.headers['x-amz-date']) return reject(res, 403, 'AccessDenied', 'missing x-amz-date')
      } else if (!url.searchParams.get('X-Amz-Credential')?.includes('/s3/aws4_request')) {
        return reject(res, 403, 'AccessDenied', 'presigned URL missing a valid credential scope')
      }

      // S3 requires each path segment to be percent-encoded with only
      // A-Za-z0-9-._~ left literal. Node's URL leaves characters like '(' and
      // ')' alone, so checking the *raw* path against the spec's rule is the
      // only way to catch a driver that skipped its own encoder — and it is the
      // encoding the signature is computed over, so a mismatch is a 403 at AWS.
      for (const rawSegment of url.pathname.split('/').filter(Boolean)) {
        const decoded = decodeURIComponent(rawSegment)
        if (rawSegment !== s3UriEncode(decoded)) {
          return reject(res, 400, 'InvalidURI', `segment "${rawSegment}" is not S3-encoded; expected "${s3UriEncode(decoded)}"`)
        }
      }

      const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
      if (segments[0] !== bucket) return reject(res, 404, 'NoSuchBucket', `no bucket ${segments[0]}`)
      const key = segments.slice(1).join('/')

      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${bucket}</Name>` +
            keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)?.body.length ?? 0}</Size></Contents>`).join('') +
            `</ListBucketResult>`,
        )
        return
      }

      switch (req.method) {
        case 'PUT':
          objects.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') })
          res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` })
          return void res.end()
        case 'GET':
        case 'HEAD': {
          const found = objects.get(key)
          if (!found) return reject(res, 404, 'NoSuchKey', `no key ${key}`)
          res.writeHead(200, { 'content-type': found.contentType, 'content-length': String(found.body.length) })
          return void res.end(req.method === 'HEAD' ? undefined : found.body)
        }
        case 'DELETE':
          objects.delete(key)
          res.writeHead(204)
          return void res.end()
        default:
          return reject(res, 405, 'MethodNotAllowed', `method ${req.method}`)
      }
    })
  }

  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    objects,
    failNextWith: (status: number) => {
      failNext = status
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * RFC 3986 unreserved-only encoding, written from the S3 signing spec rather
 * than from the driver's own helper, so agreement between them means something.
 */
function s3UriEncode(segment: string): string {
  let out = ''
  for (const byte of Buffer.from(segment, 'utf8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

function reject(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/xml' })
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`)
}
