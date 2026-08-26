import { randomBytes } from 'node:crypto'

/**
 * Prefixed, lexicographically sortable identifiers.
 *
 * Layout: `<prefix>_<48-bit ms timestamp in base32><80 bits of randomness in base32>`.
 * Sorting a column of these sorts by creation time, which keeps queue scans and
 * ledger exports in a sane order without a secondary index.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32, no I/L/O/U

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function encodeTime(ms: number): string {
  let out = ''
  let remaining = ms
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[remaining % 32] + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

export type IdPrefix =
  | 'org'
  | 'usr'
  | 'ses'
  | 'proj'
  | 'scene'
  | 'shot'
  | 'sver'
  | 'char'
  | 'cver'
  | 'env'
  | 'ever'
  | 'ast'
  | 'batch'
  | 'job'
  | 'att'
  | 'out'
  | 'qc'
  | 'rev'
  | 'mast'
  | 'del'
  | 'quote'
  | 'ledg'
  | 'bud'
  | 'audit'
  | 'qmsg'
  | 'hook'
  | 'model'
  | 'run'
  | 'key'
  // Street Banker Audio Intelligence
  | 'apol' // audio data policy
  | 'aent' // audio entitlement
  | 'akey' // keyterm
  | 'acon' // consent record
  | 'aast' // audio asset
  | 'agen' // audio generation lineage
  | 'ajob' // audio job
  | 'atrs' // transcript
  | 'aseg' // transcript segment
  | 'aspk' // transcript speaker
  | 'lead' // operator lead
  | 'note' // operator note
  | 'task' // operator task
  | 'meet' // meeting intelligence
  | 'mai' // meeting action item
  | 'mdv' // meeting deal variable
  | 'brf' // signal brief
  | 'bsch' // brief schedule
  | 'aagt' // audio agent
  | 'akdc' // agent knowledge doc
  | 'acnv' // agent conversation
  | 'voice' // voice profile
  | 'dub' // dubbing project
  | 'camp' // campaign audio project
  | 'rmx' // remix project
  | 'rver' // remix version
  | 'ause' // audio usage ledger entry
  | 'abud' // audio budget
  | 'pwh' // provider webhook event
  // Live Lab (Street Banker live-performance module)
  | 'lproj'
  | 'lset'
  | 'lscn'
  | 'lclip'
  | 'lstem'
  | 'lmap'
  | 'lout'
  | 'laij'
  | 'lpkg'
  | 'lpev'
  | 'last'
  | 'ent'
  // Street Banker Song Lab
  | 'slp' // song lab project
  | 'sv' // song version
  | 'sa' // song analysis
  | 'ssec' // song section
  | 'ssf' // song section feature
  | 'sll' // song lyric line
  | 'bcoh' // benchmark cohort
  | 'bsf' // benchmark song feature
  | 'bprov' // benchmark provenance
  | 'sbr' // song benchmark result
  | 'sobs' // song observation
  | 'srec' // song recommendation
  | 'sexp' // song experiment
  | 'sar' // song A&R review
  | 'sout' // song outcome link
  | 'shof' // song lab handoff
  | 'vst' // song lab vocal stem

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeBase32(randomBytes(10))}`
}

/** True when `id` is well-formed and carries the expected prefix. */
export function isId(prefix: IdPrefix, id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(`${prefix}_`) && id.length >= prefix.length + 20
}

/** Opaque, URL-safe random token (upload tokens, invite codes, webhook nonces). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
