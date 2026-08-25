import type { AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'

/**
 * Retention sweep, run periodically by the worker.
 *
 * Deletes what the organization's policy says has expired — source bytes,
 * transcript content, conversation transcripts — while keeping the audit
 * metadata that proves what existed and under what authorization. Deleting the
 * evidence of consent along with the content would defeat the point of both.
 */
export class RetentionService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
  ) {}

  async sweep(): Promise<{ assets: number; transcripts: number; conversations: number }> {
    const nowIso = this.deps.clock.isoNow()
    let assets = 0
    let transcripts = 0
    let conversations = 0

    for (const asset of await this.deps.repos.assets.listExpired(nowIso)) {
      try {
        await this.audioAssets.deleteAsset(asset.orgId, asset.id, 'retention_expired')
        await this.deps.audit.record({
          orgId: asset.orgId,
          actor: 'retention-sweep',
          action: 'audio.asset_retention_deleted',
          targetType: 'audio_asset',
          targetId: asset.id,
          data: { retentionKind: asset.retentionKind, expiredAt: asset.retentionExpiresAt },
        })
        assets++
      } catch (err) {
        this.deps.logger.warn('audio.retention_asset_failed', { asset_id: asset.id, err })
      }
    }

    for (const transcript of await this.deps.repos.transcripts.listExpired(nowIso)) {
      try {
        await this.deps.repos.transcripts.purgeContent(transcript.id)
        await this.deps.audit.record({
          orgId: transcript.orgId,
          actor: 'retention-sweep',
          action: 'audio.transcript_retention_deleted',
          targetType: 'transcript',
          targetId: transcript.id,
          data: { expiredAt: transcript.retentionExpiresAt },
        })
        transcripts++
      } catch (err) {
        this.deps.logger.warn('audio.retention_transcript_failed', { transcript_id: transcript.id, err })
      }
    }

    for (const conversation of await this.deps.repos.agents.listExpiredConversations(nowIso)) {
      try {
        await this.deps.repos.agents.purgeConversationContent(conversation.id)
        await this.deps.audit.record({
          orgId: conversation.orgId,
          actor: 'retention-sweep',
          action: 'audio.conversation_retention_deleted',
          targetType: 'agent_conversation',
          targetId: conversation.id,
          data: { expiredAt: conversation.retentionExpiresAt },
        })
        conversations++
      } catch (err) {
        this.deps.logger.warn('audio.retention_conversation_failed', { conversation_id: conversation.id, err })
      }
    }

    if (assets + transcripts + conversations > 0) {
      this.deps.logger.info('audio.retention_sweep', { assets, transcripts, conversations })
    }
    return { assets, transcripts, conversations }
  }
}
