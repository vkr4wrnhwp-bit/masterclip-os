import { type Db, insertRow, type Row } from '@masterclip/database'
import { newId, systemClock, type Clock } from '@masterclip/shared'

export interface SongMapCorrection {
  id: string
  orgId: string
  songAnalysisId: string
  songVersionId: string
  edits: unknown[]
  createdBy: string
  createdAt: string
}
function fromRow(row: Row): SongMapCorrection {
  return { id: String(row['id']), orgId: String(row['org_id']),
    songAnalysisId: String(row['song_analysis_id']), songVersionId: String(row['song_version_id']),
    edits: JSON.parse(String(row['edits_json'])) as unknown[],
    createdBy: String(row['created_by']), createdAt: String(row['created_at']) }
}
export class SongMapCorrectionRepo {
  constructor(private readonly db: Db, private readonly clock: Clock = systemClock) {}
  async save(input: {orgId:string;analysisId:string;versionId:string;edits:unknown[];actorId:string}): Promise<SongMapCorrection> {
    const id = newId('smc', this.clock.now())
    await insertRow(this.db, 'song_map_corrections', {
      id, org_id:input.orgId, song_analysis_id:input.analysisId,
      song_version_id:input.versionId, edits_json:JSON.stringify(input.edits),
      created_by:input.actorId, created_at:this.clock.isoNow(),
    })
    return (await this.latest(input.orgId,input.analysisId))!
  }
  async latest(orgId:string, analysisId:string):Promise<SongMapCorrection|null>{
    const row=await this.db.get('SELECT * FROM song_map_corrections WHERE org_id = ? AND song_analysis_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',[orgId,analysisId])
    return row?fromRow(row):null
  }
  async history(orgId:string,analysisId:string):Promise<SongMapCorrection[]>{
    const rows=await this.db.query('SELECT * FROM song_map_corrections WHERE org_id = ? AND song_analysis_id = ? ORDER BY created_at DESC, id DESC',[orgId,analysisId])
    return rows.map(fromRow)
  }
}
