# Song Passage — design proposal

**Validate before build.** One Street Banker suite helps an artist understand
one owned song, decide what to improve, obtain a real Rack result, approve a
version and prepare a truthful delivery package. “Song Passage” is a working
name, not approved branding. Live Lab belongs inside V1 Stage.

## User, wedge and portfolio fit

Primary user/buyer: an independent artist or producer with an existing song and
several scattered versions, who needs to decide the next useful action and
which file is actually approved. Secondary users: an invited engineer/reviewer
and the owner/operator. Existing workaround: file folders, notes/messages,
separate analysis tools and ambiguous filenames. Start with the approval and
handoff gap; the existing analysis engines are supporting evidence.

Promise: the artist can identify the current version, explain one improvement
decision and find the exact approved result. Do not promise commercial success,
automatic artistic correctness or distribution acceptance. The differentiator
is continuity across Street Banker evidence, Vault, Rack and Stage, with source
and permission history. A waveform or generic AI assistant alone is not a moat.
Switching must not require uploading every historical project or another login.

## Six-step journey

| Step | User action / first-value outcome | Surface / recovery |
| --- | --- | --- |
| 1. Choose the song | Open an owned Vault file, upload authorized audio or resume a linked record. Show source/version/rights and processing scope. | Home and Vault start. Empty state names supported inputs. No access reveals no file metadata. Upload failure retains a retryable selection. |
| 2. Understand it | Listen, inspect sections/key/tempo/confidence and choose up to three evidence-backed priorities. Correct estimates; expand lyrics/reference details only when needed. | Song work. Unknown stays unknown. Analysis has queued/running/failed/cancelled states with last valid results retained. |
| 3. Make a decision | Save a brief, approve a suggested test or decide the song needs no change. Actual creation routes to The Room/Audio Studio/Remix Lab; processing to Rack. | Song work and Rack handoff. No duplicated recording/editor. User sees exact input, destination and any cost before authorizing work. |
| 4. Finish in The Rack | Send the selected Vault version and approved brief; return an actual saved result and receipt. Manual attach is possible when a verified connection is unavailable. | Rack handoff. Pending is not success; key missing says Needs a key. Retry uses the same job key. Source stays intact. |
| 5. Compare and approve | A/B exact files with an explained level-matching option; review timestamped notes; approve one version with the actor/time. | Versions/A-B. A different upload cannot inherit approval. Revoked reviewers lose access immediately. |
| 6. Prepare delivery | Resolve metadata/rights/file blockers; save an immutable manifest/result set to Vault. Send an approved live-prep snapshot to Stage when that connection exists. | Delivery. “Saved”, “exported”, “sent” and “accepted” are separate evidenced states. Live setup is an optional Stage continuation. |

Home shows the current song, last result, a single next action and recent songs.
It is not another dashboard of subsystem tiles. Each work page uses the same
vertical order: **Start here → The work → Your results / Save to Vault → Help**.
Walkthrough is a visible, keyboard-accessible short guide; every section has
its own “?” help disclosure. Back to Street Banker and the feature checklist
(Real / Needs a key / Sample / Not built) are available in the chrome. Industry
terms are explained in brackets on first appearance. Artist copy uses “your song”
and “your mix”; technical cohort/asset terms stay in evidence/operator details.

All nineteen old tab destinations remain traceable in the plan: Overview,
Structure, Hook, Lyrics, Energy, Tempo, Arrangement, Benchmark, Producer and A&R
become named evidence panels under Understand; Experiments and Ask the Room
become decision/help panels; Session intake is Choose; stored Rack intent and
Mix Doctor/Translation/references feed the finishing brief, while actual mix/master
processing is The Rack handoff; both Version views, Comments, Collaborators and
Approvals sit under Compare/approve; Passport, Sonic DNA and Delivery remain
reachable through result/record details. These are grouped doors with clear names,
not nineteen tabs, deleted tools or hidden live functionality. A later migration
requires an inventory-to-destination checklist for every control and saved record.

## Surface design and graphic direction

Use V1 sb tokens read from `static/css/tailwind.css`: ground #0b0a08,
surface-1 #131110, ink #f2ece0, ink-2 #a99b84 and gold #c9a24a. The HTML
uses these exact values under sb token names, with off-white section bands.
Gold marks the primary action,
active step and selected version. Avoid gold body paragraphs, rainbow status
badges, fake “pro” meters, stock mixing-console imagery and decorative graphs.
Status always has words; red appears only for an actual blocker/emergency.

Use a system sans-serif throughout; no monospace, including numbers and metadata.
Body 16px, supporting text 14px, smallest 12px; a restrained 36–56px headline.
Give the song title and source/version strong hierarchy. Desktop content max
1120px with a two-column work/evidence layout, one clearly dominant action and
adequate whitespace. Thin borders and flat panels carry the layout. Keep technical
provider diagnostics in section help/operator detail, not the main artist flow.

At 375px, use a single column with 16px side padding, wrapped step links and
stacked full-width controls. No horizontally scrolling tab rail or table. Buttons,
links styled as controls, form fields and help summaries have at least 44px
targets. Keep long IDs/file names wrapping, grid children min-width:0, and visible
focus outlines. Do not hide overflowing content to pass a width check.

The mockups demonstrate seven surfaces plus dedicated 375px home/song/Stage
views. They are labelled **Sample · static design proposal**. Links/disclosures
work locally; no button claims an upload, analysis, save or performance occurred.
An unconnected feature displays its status and reason. Real/synthetic readiness
must be derived from result provenance later, never inferred from page styling.

## Live Lab inside Stage

Stage header: **Street Banker · Stage**. Enter through existing suite sign-in;
show set identity, current song, prepared scenes, package verification and one
large rehearsal/performance action. Performance has explicitly distinct selected,
queued and playing states, visible emergency stop, click and lock controls.
Preparation can be navigated on a phone; performance suitability must be tested
on the actual browser/device/controller. A ready claim requires local bytes,
checksums and successful decode, not a server flag alone.

Preserve setlists, scene/stem/pad assignments, MIDI mappings, device preferences,
offline packages, restore-without-autoplay behavior and all Stage Control bridge
security. The performer-link panel stays on the Stage Control desk. All Stage
navigation, help, labels and destinations must exclude the unrelated travel suite;
do not carry legacy sample set names into the new Stage UI. Existing three-lab
preview remains available until the owner approves an additive migration.

## State, data and permissions

Conceptual entities: owned song, immutable source asset, analysis/version and
basis, human correction, decision/brief, handoff, actual result, review/approval,
delivery manifest and audit event. Link existing Song Lab and Studio project IDs;
do not assume they can be destructively collapsed. Vault remains file authority;
suite pointers carry checksum, tenant, source version and consent. Migrations are
additive and reversible at the entry-point level.

Owner/artist can choose inputs and authorize spending; reviewers can comment
only on explicitly shared versions; approvers need explicit permission. Every
server read/write checks tenant ownership. Signed/expiring asset access and
revocation remain server-side. Cancellation stops future work, records whether
provider work already began and does not erase a completed paid result.
Notifications link to the exact result and are opt-in; no automatic email is
part of Phase 0. Export/deletion follows existing Vault retention and consent;
deleting a link must not silently delete original files.

## AI, operations and failure

Prefer deterministic measurements and existing human edits. Advisory summaries
must cite the exact sections/metrics, identify the analyzer/version and permit
correction. External transcription/separation requires a configured provider,
explicit data consent, a bounded queue, dedupe, cancel/refund rules and usage
accounting. No raw audio or lyric text in analytics/logs. No AI result may grant
rights or approve a release. Missing configuration shows Needs a key, with a
manual alternative; synthetic output stays Sample.

Operator workflow: see failed/pending handoffs and provider health, reconcile
receipt versus file existence/hash, retry safely without a second charge, and
audit permission or billing corrections. Do not let a successful HTTP enqueue
become a “finished” badge. Persist queue progress and expose human-readable
failure reasons. Backups must include pointers/receipts and continue relying on
Vault's actual file backups rather than pretending to protect another service.

## Horizons, metrics and decisions

| Horizon | Outcome / inclusion | Exclusions / dependencies | Exit evidence |
| --- | --- | --- | --- |
| MVP, after approval | Six-step linked journey, existing measurements, exact version review, manual/verified Rack result and truthful Vault delivery | No new vendor, DAW, recorder or automatic migration; sign-in and file contracts must be verified first | 8/10 pilot artists finish one journey unaided; no wrong-tenant access, lost originals, false completion or duplicate charge |
| V2, separately approved | Selected top-ten upgrades, robust collaboration and authorized handoff automation | No assumed vendor APIs; measured costs and real review demand required | Repeat use in 4 weeks by at least half of a 10-user pilot; per-job cost/support fit approved limits |
| Five-year direction | Artist-controlled decision and result lineage across releases/services | Earned from consented histories; no speculative model-training rights or monopoly claims | Demonstrated portability and repeated retained use, not a feature-count target |

Track time to first useful decision, source→result completion, handoff failures,
repeat use, approval reversals and paid-job margin. Track only IDs/state/timing,
with retention and consent controls. Willingness-to-pay and pricing scenarios
are research assumptions in FEATURE-RESEARCH.md. Do not set production tiers now.

Highest risks: cross-service identity/tenant mismatch (blocker: any leaked asset),
ambiguous version migration (blocker: any lost record), synthetic/partial output
presented as complete (blocker), unreliable device playback (block Stage move),
vendor terms/cost uncertainty (block that adapter), and demand for a duplicate
tool (reframe if pilot artists prefer existing paths). Test each before widening
the rollout. The source inventory is evidence; third-party access and live
deployment settings remain unverified.

Locked: combined song journey, Rack/Vault reuse, Live in Stage, preserve all three
preview labs, no creation workstation promise. Recommended but unapproved: name,
six-step layout, top-ten selection, linked-record identity and pilot thresholds.
Before code: Claude reviews this plan, verifies counterpart contracts, and the
owner explicitly approves the design/scope. Phase 0 ends at that review gate.
