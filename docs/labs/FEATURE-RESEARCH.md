# Feature research — 23 October 2026

**Validate before build.** Combine the useful song evidence and approval journey;
verify identity, Vault/Rack contracts and demand before adding vendor processing.
The comparisons below use official product, documentation and pricing sources.
Prices are observed public offers, not Street Banker integration quotes; tax,
region, promotions, billing period and future changes can alter them. A desktop
license never grants a right to host that vendor's engine for customers.

## Official-source comparison

| Product / users | Verified capability and public cost evidence | Street Banker feasibility and decision |
| --- | --- | --- |
| LANDR / independent artists finishing releases | Online reference mastering; public single-track offer $10. Mastering API advertises starting $2.50/track, volume quote available. [Mastering](https://www.landr.com/online-audio-mastering), [API](https://www.landr.com/pro-audio-mastering-api), [plans](https://www.landr.com/pricing). | An actual commercial API exists. Any later adapter belongs in V1 Rack, with explicit price, consent, bounded retries and immutable input/output receipts. At least $2.50 vendor cost per successful track before storage/support; retail subscription is not an API allowance. Later, pending owner/vendor agreement. |
| iZotope Ozone / mastering engineers | Ozone 12 Standard is a mastering plugin suite. [Product](https://www.izotope.com/products/ozone-standard). The subscription page advertises a $25/month or $250/year bundle; exact included edition must be checked at purchase. [Subscription](https://www.izotope.com/pages/subscriptions). | Learn from explained reference comparison and auditionable changes. No public hosted Ozone API verified. Do not claim Ozone-quality processing or run retail plugins on servers under assumed rights. Rack handles actual mastering. |
| iZotope Neutron / mix engineers | Neutron 5 offers mixing tools and an assistant; the product page places it in production bundles. [Product](https://www.izotope.com/products/neutron). Bundle/license costs are separate from hosted processing rights. | Explain which measured problem motivates a change; require human choice. Track/bus processing belongs outside this suite. No Neutron API verified. |
| iZotope Tonal Balance Control / engineers comparing references | Current TBC 3 offers reference targets and integration with Ozone/Neutron. [Product](https://www.izotope.com/products/tonal-balance-control), [official introduction](https://www.izotope.com/community/blog/tonal-balance-control-3). Available in the cited subscription bundle; standalone/upgrade offers vary. | Feasible local reference-band comparison using owned/authorized files and existing metrics. Explain uncertainty and reference basis; do not copy targets or claim industry-hit training data. Medium implementation effort, no new per-call vendor fee. |
| Sonarworks / engineers checking monitoring | SoundID Reference calibrates speakers/headphones through its app/plugin. Official page shows headphones €99 and stereo speakers/headphones €249, with hardware/add-ons separate. [Versions/pricing](https://www.sonarworks.com/soundid-reference/pricing), [product](https://www.sonarworks.com/soundid-reference). | A browser listening checklist cannot calibrate a room or replace a measured profile. Keep device notes and honest translation checks; link to external calibration tools. Licensing/hardware costs stay with the user. No calibration engine build. |
| Mixed In Key / DJs preparing sets | Key, BPM, energy and cue analysis; current Standard/Pro are one-time purchases. Amount not consistently exposed in retrieved checkout, so no numeric quote is asserted. [Features](https://mixedinkey.com/learn-more/), [Pro and purchase model](https://mixedinkey.com/pro/). | Reuse estimated key/tempo/confidence and let users correct cues in Stage. No accuracy superiority claim or assumed export/API license. Low UI effort, medium cue-validation effort. |
| Hit’n’Mix RipX / producers and remixers | RipX provides stem separation and note-level audio editing, with a 21-day trial; site advertises entry from $99. [Product](https://hitnmix.com/ripx-daw/), [pricing entry](https://hitnmix.com/). | Note editing/DAW capabilities are outside the locked scope. Accept authorized completed stems through existing Room/Remix/Vault handoffs. No RipX server API or sublicensing permission verified. No rebuild. |
| Splice / creators sourcing licensed samples | Subscription sample library, certified-license download, and a public MCP beta for catalog discovery. Plans page shows Sounds $12.99/month billed yearly and a Creator introductory $4.99 first month against $19.99 regular monthly. [Plans](https://splice.com/plans), [license](https://support.splice.com/en/articles/8652641-how-do-i-generate-a-certified-license-for-my-samples), [MCP](https://splice.com/tools/mcp-server). | Retain a user's license/provenance attachment with the song. MCP availability is not permission to redistribute a sample library. Search integration later only after auth/terms review; no instruments, samples marketplace or bulk redistribution. |
| Samply / artists and engineers seeking feedback | Audio versions and time-coded comments, including API timestamp fields. Search-indexed pricing showed Pro $28/month, but the current pricing page requires JS; treat that amount as provisional. [Pricing](https://samply.app/pricing), [comments API](https://docs.samply.app/api/comments.html). | Existing Studio comments/version permissions are a better first implementation than a second vendor store. Keep timecoded, resolved/open feedback attached to the exact version. API access/plan/consent must be verified before any external sync. Low–medium UI effort. |
| DISCO / labels and music supervisors | Metadata/playlists and controlled delivery. Plus from $16.99/month; Pro from $26.99/month, annually billed, 1 user/1k files. Enterprise lists API access, custom price. [Pricing](https://www.disco.ac/pricing), [sharing](https://support.disco.ac/home/sharing-content). | Use Vault-backed delivery and metadata validation; avoid a second catalog. External export optional later; API requires an appropriate agreement. Do not equate a locally built package with downstream acceptance. |
| Ableton Session View / live performers | Clips/scenes can launch on a grid; scenes launch rows together. [Manual](https://www.ableton.com/en/manual/session-view/). Current shop: Intro $99, Standard $349, Suite $749. [Shop](https://www.ableton.com/en/shop/live/). | Preserve Live's own local playback, quantization, cache verification and emergency stop. Borrow the task model of prepared scenes; no DAW, instruments or plugin-host promise. Device/browser tests, not a retail license, dominate migration cost. |
| Logic Live Loops / performers and producers | Cells/scenes can play in any order, one cell per track at a time. [Apple guide](https://support.apple.com/en-ph/102113). Logic Pro Mac US App Store shows $199.99. [Store](https://apps.apple.com/us/app/logic-pro/id634148309). | Stage needs clear selected/queued/playing states and safe launching, without recording, arrangement capture or instrument creation. Do not promise Logic session import. Medium UI/hardware test effort. |
| Moises / musicians practicing and separating audio | Consumer app separates stems; developer entry points lead to Music AI for business models. [Moises](https://moises.ai/), [developer](https://developer.moises.ai/), [Music AI pricing](https://music.ai/pricing/). API page advertises pay-as-you-go and a $25/month Professional plan; actual module rates/credits vary. Consumer pricing URL redirected, so no consumer price is asserted. | If separation quality warrants a paid trial, implement behind existing Room/Remix provider seams, never as another splitter in this suite. Estimate a real module's per-minute cost on licensed fixtures before approval. No recording/editor expansion. |

The vendor rows describe research evidence, not permission to recreate their
products. Only the ten numbered items below are **propose**. Vendor adapters,
external sync and catalog search are **later**; DAW/editor/calibration and engine
clones are **no**. Existing raw analysis/review features are being redesigned or
connected, not counted as new unbuilt engines.

## Exactly ten top proposals for owner selection

All ten rows below are marked **propose**, not approvals to implement. Effort estimates are
engineering planning assumptions: S = 2–4 days, M = 1–2 weeks, L = 2–4 weeks,
excluding security review and vendor negotiation. Validate against repository
tests before scheduling. None requires a competitor license to reproduce its UI.

| # | Proposal / user outcome | Reuse and feasibility | Cost / validation gate |
| --- | --- | --- | --- |
| 1 · propose | One song map with editable sections, key/tempo confidence and three evidence-backed next actions | Existing Song Lab analysis/corrections. Present measured basis, source version and “not enough information”; no hit score. | M; local compute/storage. 8/10 artists identify a useful action without help. |
| 2 · propose | One immutable version history and level-aware A/B | Consolidate navigation around linked Song/Studio IDs, retaining both histories and approvals. Explain normalization; original files unchanged. | M; audio streaming/egress. Prove no version or approval is lost; listening-bias usability test. |
| 3 · propose | Owned-reference tonal comparison | Existing mix/reference metrics, inspired by TBC's contextual display. Show broad differences and provenance, not a copied target curve or quality grade. | M; local analysis. Controlled fixtures and expert review of misleading findings. |
| 4 · propose | Translation listening notes | Phone/headphone/mono checklist plus actual measured stereo/peak information. Distinguish listening observation from device calibration. | S; no new vendor fee. Test users understand it does not calibrate their speakers. |
| 5 · propose | Lyric evidence review | Existing manual/transcription line provenance, timing correction and title/chorus evidence. Never silently replace confirmed words. | M; external transcription optional and capped. WER/timing fixtures, consent and 100% preserved human corrections. |
| 6 · propose | Rack round trip with a real result receipt | Vault input/version + approved brief → V1 Rack → saved actual result linked back. Display pending/failed/completed separately. | L across repos; Rack vendor fee only after estimate/consent. Duplicate retry must create no duplicate paid job or lost result. |
| 7 · propose | Version-bound review and approval | Existing Studio comments, resolved feedback and role checks, inspired by Samply. One clear “approve this exact version” action. | M; notifications/storage if enabled. Cross-tenant/revocation tests and five real review sessions. |
| 8 · propose | Delivery checklist with evidence | Existing metadata/rights/file checks into a Vault result set and manifest. Show blockers and distinguish exported from accepted by a destination. | M; storage/egress. Fixture round trip preserves file hashes and metadata; no false completion. |
| 9 · propose | Prepared Live set inside Stage | Move the existing playback/cache/MIDI/package experience behind Stage sign-in, with safe selected/queued/playing states inspired by Session View/Live Loops. | L; local disk/cache plus optional generation fees. Offline rehearsal, reload, hardware loss and emergency stop must pass before migration. |
| 10 · propose | Rights and source lineage attached to every result | Existing consent/provenance plus Vault source and imported sample-license attachments. Human review precedes delivery; no legal-rights certification claim. | M; storage/review effort. Trace one result to exact source, permission and operator across handoffs. |

Cost classification: picks 1–4, 7–10 use existing/local code with **no new vendor
fee on our side** (hosting, compute, storage and support still cost money). Pick 5
has a free/manual path and an optional **paid provider** transcription path. Pick
6 is a handoff feature with no new processor here; Rack work may carry a **paid
API** charge shown before consent. Desktop engine hosting without commercial
permission is **not possible under an assumed retail license**.

## Later / no

**later** — LANDR or Music AI provider trials: later through Rack/Room only, following measured
quality, signed commercial terms and a capped cost experiment. Splice discovery,
Samply sync and DISCO export: later after verified API entitlement and a demonstrated
need that existing Vault/review flows cannot meet. Learned artist preferences and
album-wide consistency: later after version approval data and user opt-in exist.
**no** — DAW, recording, multitrack editor, instruments, note-level stem editing,
automated licensing, universal hit formula, room calibration claim, copied vendor
presets or parallel storage/catalog platform.

## Economics and quality experiment

Keep the combined suite in existing Street Banker sign-in/entitlements; do not
invent a separate account/subscription in Phase 0. Compare willingness to pay for
an included core journey versus a later $10–20/month add-on (hypothesis only).
Processing uses the existing credit boundary with a visible estimate, consent,
budget cap and idempotency; provider failure must release/refund reservations.
Local measurements can be cached by asset hash + analyzer version. No dataset
training on uploaded songs without separately recorded permission.

Illustrative monthly add-on scenarios, not forecasts: 50 × $10 = $500 low,
200 × $15 = $3,000 base, 500 × $20 = $10,000 high, before tax/payment/support/
hosting. One LANDR API master for each customer at the advertised starting rate
would cost at least $125/$500/$1,250 respectively; this excludes any higher quote,
repeat masters, transcription, storage and egress. Charge paid actions separately
until measured margins justify a bundle. Kill an integration if users cannot
hear/identify its value or provider cost/retries erase the planned contribution.

Evaluate advisory features on owned synthetic/authorized fixtures and diverse
genres: tempo/key error, section-boundary tolerance, lyric correction retention,
reference provenance, A/B loudness bias and false readiness. A human can override
every interpretation. A missing key or uncertain finding must never be replaced
with an invented confident result. Benchmark sample sizes/bases stay visible.
