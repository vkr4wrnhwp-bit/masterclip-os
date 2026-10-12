export interface RollbackBackupResult {
  skipped?: boolean
  verified?: boolean
  existing?: boolean
  releaseId?: string
  databaseFilename?: string
  backupPath?: string
  sha256?: string
}
export function verifyPreMigrationBackup(
  env:Record<string,string|undefined>,
  options?:{mountPath?:string;releaseId?:string},
):Promise<RollbackBackupResult>
