import type { Shot } from '../api.js'

export function variantParent(shot: Shot): string | null {
  const data = (shot.spec ?? {}) as Record<string, unknown>
  const variant = data.creative_variant
  if (typeof variant !== 'object' || variant === null) return null
  const source = (variant as { source_shot_id?: unknown }).source_shot_id
  return typeof source === 'string' && source.trim() ? source : null
}

/** Resolve the earliest loaded ancestor without trusting arbitrary source IDs.
 * Broken chains and cycles are shown as independent groups, never fabricated
 * as links to another artist/project.
 */
export function variationRoot(shotId: string, shots: readonly Shot[]): string {
  const map = new Map(shots.map(item => [item.id, item]))
  const visited = new Set<string>()
  let current = shotId
  while (true) {
    if (visited.has(current)) return shotId
    visited.add(current)
    const shot = map.get(current)
    if (!shot) return shotId
    const parent = variantParent(shot)
    if (!parent) return current
    if (!map.has(parent)) return shotId
    current = parent
  }
}

export function areRelatedVariants(leftId: string, rightId: string, shots: readonly Shot[]): boolean {
  return Boolean(leftId && rightId && leftId !== rightId &&
    variationRoot(leftId, shots) === variationRoot(rightId, shots))
}
