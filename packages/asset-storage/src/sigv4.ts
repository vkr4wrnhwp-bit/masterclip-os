import { createHash, createHmac } from 'node:crypto'

/**
 * Minimal AWS SigV4 for S3-compatible object stores (AWS S3, Cloudflare R2,
 * MinIO, Backblaze B2's S3 endpoint).
 *
 * Hand-rolled rather than pulling in the AWS SDK: the pipeline needs exactly
 * four operations (PUT, GET, HEAD, DELETE) plus presigned GETs, and the SDK is
 * a large dependency surface for that. The signing steps below follow the
 * published SigV4 algorithm and are covered by unit tests against the AWS
 * documentation's own test vector.
 */
export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignRequestInput {
  method: string
  url: URL
  region: string
  service?: string
  credentials: SigV4Credentials
  headers?: Record<string, string>
  /** Hex sha256 of the body; 'UNSIGNED-PAYLOAD' is valid for HTTPS S3. */
  payloadHash: string
  date?: Date
}

const ALGORITHM = 'AWS4-HMAC-SHA256'

/** RFC 3986 encoding — S3 requires `!'()*` escaped, which encodeURIComponent leaves alone. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = ''
  for (const ch of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(ch)
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c
    else if (c === '/') out += encodeSlash ? '%2F' : '/'
    else out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request')
}

function amzDates(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

function canonicalQuery(url: URL): string {
  const params = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return params.map(([k, v]) => `${k}=${v}`).join('&')
}

function canonicalPath(url: URL): string {
  return uriEncode(decodeURIComponent(url.pathname), false)
}

/** Returns the headers to send, including `authorization`. */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const service = input.service ?? 's3'
  const date = input.date ?? new Date()
  const { amzDate, dateStamp } = amzDates(date)

  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': input.payloadHash,
  }
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken

  const sortedKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
  const canonicalHeaders = sortedKeys
    .map((k) => {
      const value = Object.entries(headers).find(([hk]) => hk.toLowerCase() === k)?.[1] ?? ''
      return `${k}:${String(value).trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')
  const signedHeaders = sortedKeys.join(';')

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, dateStamp, input.region, service))
    .update(stringToSign, 'utf8')
    .digest('hex')

  headers.authorization = `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

export interface PresignInput {
  method?: string
  url: URL
  region: string
  service?: string
  credentials: SigV4Credentials
  expiresSeconds: number
  date?: Date
}

/** Presigned URL (query-string auth), used for browser playback of assets. */
export function presignUrl(input: PresignInput): string {
  const service = input.service ?? 's3'
  const date = input.date ?? new Date()
  const { amzDate, dateStamp } = amzDates(date)
  const url = new URL(input.url.toString())
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`

  url.searchParams.set('X-Amz-Algorithm', ALGORITHM)
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.floor(input.expiresSeconds))))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  if (input.credentials.sessionToken) url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken)

  const canonicalRequest = [
    (input.method ?? 'GET').toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, dateStamp, input.region, service))
    .update(stringToSign, 'utf8')
    .digest('hex')
  url.searchParams.set('X-Amz-Signature', signature)
  return url.toString()
}
