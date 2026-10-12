import { AppError } from '@masterclip/shared'
import type { AppConfig } from '@masterclip/shared'

/** New local FFmpeg media workflows remain gated for the first rollout.
 * Existing provider generation posture and legacy delivery paths are unchanged.
 * Enabling later requires an explicit reviewed environment change.
 */
export function nativeFinishingEnabled(
  config: Pick<AppConfig, 'NODE_ENV'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return config.NODE_ENV !== 'production' || env.MOTION_ENABLE_NEW_MEDIA_FINISHING === 'true'
}
export function requireNativeFinishing(
  config: Pick<AppConfig, 'NODE_ENV'>,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!nativeFinishingEnabled(config,env)) {
    throw new AppError({
      kind:'forbidden',code:'motion.media_finishing_release_paused',
      message:'New MOTION media finishing is paused during controlled release validation.',
    })
  }
}
