# Street Banker account wipe

This draft is based on security-pass-2 (ae4a82c2), as allowed in the brief,
so it reuses the existing MOTION-specific sign-in key helper. It is not deployed.

POST /api/street-banker/wipe accepts the same signed JSON token as the V2
receiver: the street-banker-suite-wipe-v1 salt, MOTION suite, and a 60-second
expiry. SUITE_SSO_SECRET_MOTION wins; SUITE_SSO_SECRET is the fallback only
when the MOTION key is absent. No browser session authorizes a wipe.

Migration 0009 records a hash of each accepted nonce independently of the
account, so deleting the account or restarting the API does not enable replay.
The response uses the V2 status and answer shape, including used, failed,
not_configured, and too_large. Tokens and email addresses are not logged.

The receiver removes the account's project graph, uploads and rendered files
under each exact project storage prefix, queue records, spend and credit rows,
sessions, and the account. Its dedicated Street Banker organization and its
credentials are removed only when no other account belongs to it. In a shared
organization, only projects whose creation audit names this account are selected.
An identity mismatch, an active render or finish, or an asset shared across
project boundaries is refused rather than risking another account's files.

A failed storage delete rolls back database changes and the nonce receipt so
the sender can retry. Files already deleted before a failure cannot be restored;
the retained rows make retry possible. This is not an atomic transaction across
the database and object storage. Active work must finish before a retry succeeds.

## Sender follow-up

The inspected main-app security-pass-2 sender (1d29d421) still dispatches only
to the V2 suite list. It does not yet dispatch a MOTION wipe. This PR adds the
receiver, not sender enrollment; Claude must review that integration separately
before anyone claims main-app account deletion reaches MOTION end to end.
Tour's older receiver uses a different salt; this endpoint follows the current
shared V2/main-app wipe contract, not Tour's older contract.

## Evidence

tests/suite-wipe.test.ts exercises an isolated SQLite database and local file
storage with two complete account graphs, real Python-signed wire-format
evidence, key precedence, signature/expiry/suite/identity rejection, replay,
concurrent replay, oversized bodies, active work, and storage failure with retry.
No live account, paid renderer, cloud bucket, or provider-side copy is accessed.
PostgreSQL and cloud storage execution still require environment-level testing.
