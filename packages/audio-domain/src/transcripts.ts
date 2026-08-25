import { type Db, insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { NormalizedTranscript, TranscriptSegmentData } from '@masterclip/audio-core'

export interface TranscriptRecord {
  id: string
  orgId: string
  audioAssetId: string
  provider: string
  language: string
  languageConfidence: number | null
  fullText: string
  confidence: number | null
  status: 'processing' | 'complete' | 'failed' | 'deleted'
  retentionExpiresAt: string | null
  createdAt: string
}

export interface TranscriptSpeakerRecord {
  id: string
  transcriptId: string
  providerSpeakerKey: string
  displayName: string
  personId: string | null
  manuallyConfirmed: boolean
}

export interface TranscriptSegmentRecord extends TranscriptSegmentData {
  id: string
  transcriptId: string
}

export class TranscriptRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async createFromNormalized(input: {
    orgId: string
    audioAssetId: string
    provider: string
    transcript: NormalizedTranscript
    retentionExpiresAt: string | null
  }): Promise<TranscriptRecord> {
    const now = this.clock.isoNow()
    const record: TranscriptRecord = {
      id: newId('atrs', this.clock.now()),
      orgId: input.orgId,
      audioAssetId: input.audioAssetId,
      provider: input.provider,
      language: input.transcript.language,
      languageConfidence: input.transcript.languageConfidence ?? null,
      fullText: input.transcript.fullText,
      confidence: input.transcript.confidence ?? null,
      status: 'complete',
      retentionExpiresAt: input.retentionExpiresAt,
      createdAt: now,
    }
    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'audio_transcripts', {
        id: record.id,
        org_id: record.orgId,
        audio_asset_id: record.audioAssetId,
        provider: record.provider,
        language: record.language,
        language_confidence: record.languageConfidence,
        full_text: record.fullText,
        confidence: record.confidence,
        status: record.status,
        raw: JSON.stringify(input.transcript.raw ?? null),
        retention_expires_at: record.retentionExpiresAt,
        deleted_at: null,
        created_at: now,
      })
      const speakerKeys = new Set<string>()
      for (const segment of input.transcript.segments) {
        await insertRow(tx, 'audio_transcript_segments', {
          id: newId('aseg', this.clock.now()),
          org_id: record.orgId,
          transcript_id: record.id,
          speaker_key: segment.speakerKey,
          start_ms: segment.startMs,
          end_ms: segment.endMs,
          seg_text: segment.text,
          confidence: segment.confidence ?? null,
          entities: JSON.stringify(segment.entities ?? []),
        })
        if (segment.speakerKey) speakerKeys.add(segment.speakerKey)
      }
      for (const key of speakerKeys) {
        await insertRow(tx, 'audio_transcript_speakers', {
          id: newId('aspk', this.clock.now()),
          org_id: record.orgId,
          transcript_id: record.id,
          provider_speaker_key: key,
          display_name: key.replace(/_/g, ' '),
          person_id: null,
          manually_confirmed: 0,
        })
      }
    })
    return record
  }

  async get(orgId: string, id: string): Promise<TranscriptRecord> {
    const row = await this.db.get('SELECT * FROM audio_transcripts WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [id, orgId])
    if (!row) throw notFound('transcript', id)
    return mapTranscript(row)
  }

  async segments(orgId: string, transcriptId: string): Promise<TranscriptSegmentRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM audio_transcript_segments WHERE transcript_id = ? AND org_id = ? ORDER BY start_ms',
      [transcriptId, orgId],
    )
    return rows.map((row) => ({
      id: toStr(row.id),
      transcriptId: toStr(row.transcript_id),
      speakerKey: toStrOrNull(row.speaker_key),
      startMs: toNum(row.start_ms),
      endMs: toNum(row.end_ms),
      text: toStr(row.seg_text),
      ...(toNumOrNull(row.confidence) !== null ? { confidence: toNum(row.confidence) } : {}),
      entities: parseJsonColumn(row.entities, []),
    }))
  }

  async speakers(orgId: string, transcriptId: string): Promise<TranscriptSpeakerRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM audio_transcript_speakers WHERE transcript_id = ? AND org_id = ? ORDER BY provider_speaker_key',
      [transcriptId, orgId],
    )
    return rows.map((row) => ({
      id: toStr(row.id),
      transcriptId: toStr(row.transcript_id),
      providerSpeakerKey: toStr(row.provider_speaker_key),
      displayName: toStr(row.display_name),
      personId: toStrOrNull(row.person_id),
      manuallyConfirmed: toBool(row.manually_confirmed),
    }))
  }

  /**
   * Human transcript correction. The edit lands in the segment, and the
   * transcript's full text is rebuilt from segments so extraction, captions
   * and search all see the corrected version — never a stale provider copy.
   */
  async updateSegmentText(orgId: string, transcriptId: string, segmentId: string, text: string): Promise<void> {
    const result = await this.db.run(
      'UPDATE audio_transcript_segments SET seg_text = ? WHERE id = ? AND transcript_id = ? AND org_id = ?',
      [text, segmentId, transcriptId, orgId],
    )
    if (result.changes === 0) throw notFound('transcript segment', segmentId)
    const segments = await this.segments(orgId, transcriptId)
    await this.db.run('UPDATE audio_transcripts SET full_text = ? WHERE id = ? AND org_id = ?', [
      segments.map((segment) => segment.text).join(' '),
      transcriptId,
      orgId,
    ])
  }

  async renameSpeaker(orgId: string, transcriptId: string, providerSpeakerKey: string, displayName: string): Promise<void> {
    const result = await this.db.run(
      `UPDATE audio_transcript_speakers SET display_name = ?, manually_confirmed = 1
        WHERE transcript_id = ? AND org_id = ? AND provider_speaker_key = ?`,
      [displayName, transcriptId, orgId, providerSpeakerKey],
    )
    if (result.changes === 0) throw notFound('transcript speaker', providerSpeakerKey)
  }

  /** Rehydrates the normalized transcript for extraction. */
  async toNormalized(orgId: string, transcriptId: string): Promise<{ record: TranscriptRecord; transcript: NormalizedTranscript; speakerNames: Record<string, string> }> {
    const record = await this.get(orgId, transcriptId)
    const segments = await this.segments(orgId, transcriptId)
    const speakers = await this.speakers(orgId, transcriptId)
    const speakerNames: Record<string, string> = {}
    for (const speaker of speakers) speakerNames[speaker.providerSpeakerKey] = speaker.displayName
    return {
      record,
      transcript: {
        language: record.language,
        ...(record.languageConfidence !== null ? { languageConfidence: record.languageConfidence } : {}),
        fullText: record.fullText,
        ...(record.confidence !== null ? { confidence: record.confidence } : {}),
        segments,
        raw: null,
      },
      speakerNames,
    }
  }

  async listExpired(nowIso: string, limit = 100): Promise<TranscriptRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM audio_transcripts
        WHERE deleted_at IS NULL AND retention_expires_at IS NOT NULL AND retention_expires_at < ?
        ORDER BY retention_expires_at ASC LIMIT ${Math.floor(limit)}`,
      [nowIso],
    )
    return rows.map(mapTranscript)
  }

  /**
   * Retention delete: text content is removed, the row survives as audit
   * metadata (that a transcript existed, when, from which asset).
   */
  async purgeContent(id: string): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.transaction(async (tx) => {
      await tx.run(`UPDATE audio_transcripts SET full_text = '', raw = 'null', status = 'deleted', deleted_at = ? WHERE id = ?`, [now, id])
      await tx.run('DELETE FROM audio_transcript_segments WHERE transcript_id = ?', [id])
    })
  }
}

function mapTranscript(row: Record<string, unknown>): TranscriptRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    audioAssetId: toStr(row.audio_asset_id),
    provider: toStr(row.provider),
    language: toStr(row.language),
    languageConfidence: toNumOrNull(row.language_confidence),
    fullText: toStr(row.full_text),
    confidence: toNumOrNull(row.confidence),
    status: toStr(row.status) as TranscriptRecord['status'],
    retentionExpiresAt: toStrOrNull(row.retention_expires_at),
    createdAt: toStr(row.created_at),
  }
}
