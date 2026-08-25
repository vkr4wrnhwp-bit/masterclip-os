import { insertRow, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, systemClock, type Clock } from '@masterclip/shared'
import type { SongLyricLineRecord } from './types.js'

/**
 * Lyric lines.
 *
 * Attached to a *version*, not an analysis: an edited lyric belongs to the song
 * and must survive reanalysis. `lyricSource` records how the words arrived —
 * typed by the user, transcribed from their own audio, or supplied time-coded —
 * because the rights position differs and the analysis layer refuses to run on
 * lyrics with no recorded basis.
 */
export class SongLyricRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async replaceAll(
    orgId: string,
    versionId: string,
    lines: Array<{
      text: string
      lineIndex: number
      sectionId?: string | null
      startMs?: number | null
      endMs?: number | null
      syllableCount: number
      titlePhrase?: boolean
      hookPhrase?: boolean
      userConfirmed?: boolean
    }>,
    lyricSource: string,
  ): Promise<SongLyricLineRecord[]> {
    await this.db.run('DELETE FROM song_lyric_lines WHERE org_id = ? AND song_version_id = ?', [orgId, versionId])
    const now = this.clock.isoNow()
    const created: SongLyricLineRecord[] = []
    for (const line of lines) {
      const id = newId('sll', this.clock.now())
      await insertRow(this.db, 'song_lyric_lines', {
        id,
        org_id: orgId,
        song_version_id: versionId,
        section_id: line.sectionId ?? null,
        line_index: line.lineIndex,
        start_ms: line.startMs ?? null,
        end_ms: line.endMs ?? null,
        text: line.text,
        syllable_count: line.syllableCount,
        title_phrase: line.titlePhrase ? 1 : 0,
        hook_phrase: line.hookPhrase ? 1 : 0,
        user_confirmed: line.userConfirmed ? 1 : 0,
        lyric_source: lyricSource,
        created_at: now,
        updated_at: now,
      })
      created.push({
        id,
        orgId,
        songVersionId: versionId,
        sectionId: line.sectionId ?? null,
        lineIndex: line.lineIndex,
        startMs: line.startMs ?? null,
        endMs: line.endMs ?? null,
        text: line.text,
        syllableCount: line.syllableCount,
        titlePhrase: Boolean(line.titlePhrase),
        hookPhrase: Boolean(line.hookPhrase),
        userConfirmed: Boolean(line.userConfirmed),
        lyricSource,
        createdAt: now,
        updatedAt: now,
      })
    }
    return created
  }

  async list(orgId: string, versionId: string): Promise<SongLyricLineRecord[]> {
    const rows = await this.db.query('SELECT * FROM song_lyric_lines WHERE org_id = ? AND song_version_id = ? ORDER BY line_index ASC', [
      orgId,
      versionId,
    ])
    return rows.map(mapLine)
  }

  async hasLyrics(orgId: string, versionId: string): Promise<boolean> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM song_lyric_lines WHERE org_id = ? AND song_version_id = ?', [
      orgId,
      versionId,
    ])
    return toNum(row?.total) > 0
  }

  /** Marks lines as the title phrase. A user mark outranks any detection. */
  async markTitleLines(orgId: string, versionId: string, lineIndexes: number[]): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.run('UPDATE song_lyric_lines SET title_phrase = 0, updated_at = ? WHERE org_id = ? AND song_version_id = ?', [
      now,
      orgId,
      versionId,
    ])
    for (const index of lineIndexes) {
      await this.db.run(
        'UPDATE song_lyric_lines SET title_phrase = 1, user_confirmed = 1, updated_at = ? WHERE org_id = ? AND song_version_id = ? AND line_index = ?',
        [now, orgId, versionId, index],
      )
    }
  }

  async markHookLines(orgId: string, versionId: string, lineIndexes: number[]): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.run('UPDATE song_lyric_lines SET hook_phrase = 0, updated_at = ? WHERE org_id = ? AND song_version_id = ?', [
      now,
      orgId,
      versionId,
    ])
    for (const index of lineIndexes) {
      await this.db.run(
        'UPDATE song_lyric_lines SET hook_phrase = 1, user_confirmed = 1, updated_at = ? WHERE org_id = ? AND song_version_id = ? AND line_index = ?',
        [now, orgId, versionId, index],
      )
    }
  }

  /** Carries an approved lyric onto a new version created by an experiment. */
  async copyToVersion(orgId: string, fromVersionId: string, toVersionId: string): Promise<void> {
    const lines = await this.list(orgId, fromVersionId)
    if (lines.length === 0) return
    await this.replaceAll(
      orgId,
      toVersionId,
      lines.map((line) => ({
        text: line.text,
        lineIndex: line.lineIndex,
        // Section ids belong to the source analysis; the new version gets its
        // own sections, so the mapping is re-derived rather than copied wrong.
        sectionId: null,
        startMs: line.startMs,
        endMs: line.endMs,
        syllableCount: line.syllableCount,
        titlePhrase: line.titlePhrase,
        hookPhrase: line.hookPhrase,
        userConfirmed: line.userConfirmed,
      })),
      lines[0]!.lyricSource,
    )
  }
}

function mapLine(row: Row): SongLyricLineRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songVersionId: toStr(row.song_version_id),
    sectionId: toStrOrNull(row.section_id),
    lineIndex: toNum(row.line_index),
    startMs: toNumOrNull(row.start_ms),
    endMs: toNumOrNull(row.end_ms),
    text: toStr(row.text),
    syllableCount: toNum(row.syllable_count),
    titlePhrase: toBool(row.title_phrase),
    hookPhrase: toBool(row.hook_phrase),
    userConfirmed: toBool(row.user_confirmed),
    lyricSource: toStr(row.lyric_source),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
