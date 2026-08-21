import { z } from 'zod/v4'
import { CanonicalShot } from './shot.js'
import { CharacterRecord, EnvironmentRecord, StyleBible } from './bible.js'

export * from './enums.js'
export * from './shot.js'
export * from './requirements.js'
export * from './validate.js'
export * from './bible.js'
export * from './io.js'

/**
 * JSON Schema is generated from the same zod definitions the runtime validates
 * against, so the published contract cannot drift from the enforced one.
 * `pnpm masterclip shots schema` writes these to disk for external tooling.
 */
export function shotJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CanonicalShot, { io: 'input' }) as Record<string, unknown>
}

export function characterJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CharacterRecord, { io: 'input' }) as Record<string, unknown>
}

export function environmentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EnvironmentRecord, { io: 'input' }) as Record<string, unknown>
}

export function styleBibleJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(StyleBible, { io: 'input' }) as Record<string, unknown>
}
