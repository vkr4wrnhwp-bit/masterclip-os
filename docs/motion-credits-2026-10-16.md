# MOTION render credits

Owner, October 15: MOTION is credits-only; no included video. This branch starts
at motion-live 8e11c0f5b903bd43d26acfb0a59eb45e58e068d1, separate from account wipe.

Every live provider generation passes the existing budget gates and then a
confirmed credit spend before submit. The model's real tier selects motion.draft,
motion.standard or motion.premium; provider-normalized whole seconds are the
units (1–100). The main app prices those at 3, 6 and 16 credits a second. MOTION
does not grant free video, and output acceptance or rejection does not refund it.
The local mock/sandbox remains a labelled, non-billable test facility.

The credit client uses the street-banker-suite-credits-v1 salt and Python
itsdangerous wire format. SUITE_SSO_SECRET_MOTION wins when set; otherwise it
uses SUITE_SSO_SECRET. The configured STREET_BANKER_URL must use HTTPS. Requests
have a ten-second deadline and refuse redirects. A missing configuration,
refusal, malformed answer or unavailable door blocks provider submission.

The render creator must belong to the project organization and have a matching
email vouched for by a Street Banker sign-in. A self-entered local email cannot
charge somebody else's wallet. The persisted attempt receipt keeps that payer,
the action and seconds fixed across lost responses and retries. Migration
0009_motion_credit_spends adds those receipts; deleting the render cascades to
its receipts, including when the separate wipe receiver is integrated.

Each generation gets a ref made from the render ID and attempt number. A lost
spend reply retries the same ref. A new paid attempt gets a new ref. Provider
failure queues a durable refund under the same ref; a confirmed refund is not
sent again. A lost refund reply can be retried because the main-app door refunds
each ref once. Exhausted refund retries stay in the existing dead-letter queue
for operator review. An interrupted submit with an unknown provider outcome
keeps its charge for reconciliation; it does not grant an unconfirmed free video.

LIVE_SPEND_CAP_USD remains the service brake. CUSTOMER_SPEND_CAP_USD remains a
monthly safety limit using the existing provider-cost ledger, not a video grant
or a dollar value assigned to the artist's credit wallet. Credits never lift it.
Provider costs remain counted after a failed generation even when artist credits
are refunded. The wording now explicitly calls it a safety cap on paid work.
Plan-time human approval is retained only up to its approved provider estimate,
so premium work is still approved explicitly and a higher re-quote stops it.

A 402 keeps the door's need and balance and shows a Buy credits link above the
queue, opening /billing#credits in another tab. Other errors have no purchase
button. The component uses 14px text and a 44px target.

## Integration dependency

Read contract: music-artist-hub credits-live bd648baa6781ca0c5e0b30e9ef2f74704864084f,
app.py, sb_suite_sso.py and plans.py. That version's credit verifier still reads
only SUITE_SSO_SECRET. It will reject a different MOTION-specific key until its
verifier is updated separately. This PR follows the owner's requested key
preference; it does not modify the main app or settings. The shared-key contract
and Python token compatibility are tested locally, not against a deployed door.

## Local evidence

- pnpm exec vitest run tests/motion-credits.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism: 23 passed, 0 failed.
- pnpm exec vitest run packages/cost-engine/test/customer-cap.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism: 27 passed, 0 failed.
- pnpm typecheck: all 27 projects passed.
- A rendered-component Chromium fixture at 375px and 1280px: 44px link height,
  14px text, no horizontal overflow, new-tab link and preserved suite page.

Tests use an isolated SQLite database, a fake video provider and a fake credit
door. Python itsdangerous independently verifies actual outgoing test tokens
under both key choices. No real credits, payment, cloud storage or video provider
was used. The initial regression failed because the old code made no spend call;
the final counts above passed. Browser evidence is for the actual notice
component and stylesheet, not a physical phone or a live wallet transaction.
Screenshots are outside the repository. GitHub CI is separate and is not claimed
green. Nothing is deployed; the PR remains a draft for Claude.
