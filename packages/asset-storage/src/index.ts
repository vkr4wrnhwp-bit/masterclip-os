import { DEV_ASSET_SIGNING_SECRET, loadConfig, type AppConfig } from '@masterclip/shared'
import type { StorageDriver } from './driver.js'
import { LocalStorage } from './local.js'
import { S3Storage } from './s3.js'

export * from './driver.js'
export { LocalStorage, signAssetKey, verifySignedUrl } from './local.js'
export { S3Storage, downloadToFile } from './s3.js'
export * from './sigv4.js'
export * from './expiry.js'

export function createStorage(config: AppConfig = loadConfig()): StorageDriver {
  if (config.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      endpoint: config.S3_ENDPOINT,
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    })
  }
  return new LocalStorage({
    root: config.STORAGE_LOCAL_ROOT,
    signingSecret: config.ASSET_SIGNING_SECRET || devSigningSecret(config),
  })
}

/**
 * Development fallback so a clean checkout runs without generating secrets by
 * hand. Refuses to apply outside development — a production deployment must
 * set ASSET_SIGNING_SECRET explicitly or asset links would be forgeable by
 * anyone who read this file.
 */
function devSigningSecret(config: AppConfig): string {
  if (config.NODE_ENV === 'production') {
    throw new Error('ASSET_SIGNING_SECRET must be set when NODE_ENV=production')
  }
  return DEV_ASSET_SIGNING_SECRET
}
