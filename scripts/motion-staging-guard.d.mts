export interface StagingGuardResult {
  ok: boolean
  errors: string[]
  note: string
}
export function inspectStagingEnvironment(config: Record<string, string | undefined>): StagingGuardResult
