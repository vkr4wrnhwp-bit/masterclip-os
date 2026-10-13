# MOTION — Isolated Staging Preflight

This document is a release-gate artifact, not a staging deployment.

## Verified hosting boundary
The connected Render MOTION service `srv-da233s2jnfac73ahjhi0` runs the `motion-live` branch with automatic deployment enabled, one Docker instance and persistent data at `/var/data`. It is **live**, not disposable staging. Do not use it for destructive migration or process-kill experiments.

The existing `street-banker-motion-guided-preview` is only a static guided-learning preview. It does not run the MOTION API or a durable media worker.

## Automated isolated rehearsal

The new test `tests/motion-disposable-staging-upgrade.test.ts` creates a disposable SQLite database in a temporary directory. It applies only the original 0001–0003 schema, inserts a sentinel organization record, closes and reopens the file, applies the 0004–0007 MOTION schema, verifies sentinel survival and all new tables, confirms a repeated migration is a no-op, then reopens and rechecks the original record. This does **not** touch a customer or hosted database.

Run from a local isolated checkout:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/motion-disposable-staging-upgrade.test.ts tests/motion-two-connection-worker.test.ts
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Separate hosted staging required

Provision a staging service only after explicit cost approval. Use a nonproduction branch, private test accounts, separate test media storage and shared staging PostgreSQL. Verify a backup and restore, forward migrations, two independent media workers, controlled worker interruption during FFmpeg, rights revocation, source checksums and duplicate-output protection. Then run physical iPhone/Android acceptance.

Never point the test environment at the live SQLite file, the live persistent volume or live provider credentials. No hosted resources were provisioned during this preflight.
