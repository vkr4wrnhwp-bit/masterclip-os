# Street Banker Song Lab — design proposal

**Validate before build.** One Street Banker suite helps an artist understand
one owned song, decide what to improve, obtain a real Rack result, approve a
version and prepare a truthful delivery package. The owner chose **Street Banker Song Lab**, monogram **SL**. Use the full public
name in marketing; see NAMES.md for the acknowledged SongLab collisions. Live Lab belongs inside V1 Stage.

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
and “your mix”; technical comparison-group/file terms stay in evidence/operator details.

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

## Round 3 — owner-locked visual system

This revision supersedes the previous material and typography direction. The
feature map and all feature destinations remain unchanged. The visual rule is
**white text on black; gold for action and highlight**. No tinted neutral,
paper treatment, background colour wash or alternate palette is permitted.

### Exact colour contract

| Role | Exact values | Use |
| --- | --- | --- |
| Ground | #000000 | Page and instrument glass |
| Panels | #0A0A0A / #111111 / #1A1A1A | Surface, panel and raised surface |
| Lines | #262626 / #3A3A3A | Normal and strong separation |
| Text | #FFFFFF | Primary text, song title and instrument values |
| Supporting text | #B8B8B8 / #8C8C8C | Secondary and tertiary; never darker text on black |
| Gold | #C9A24A / #E8B950 / #8A6E30 | Main accent, bright action/highlight, deep edge/pressed state |
| On gold | #000000 | Primary button text |
| Status | #4CC38A / #F2A93B / #E5484D | Good, warning, blocking; words always accompany state |

White at 0.06 alpha is the 1px panel top highlight. Black shadows and a very
subtle monochrome noise filter supply depth. Other neutral fills are the exact
pure greys above. The artwork, figures and embedded logo follow the same palette.
Red is used only for blocking examples and the emergency stop. Gold is never a
large background wash or a replacement for white body copy.

### Three proposed suite splashes

The owner has not selected a separate suite colour. These are colour directions
for review, not additions to the allowed mockup palette:

| Option | Why it could work | Portfolio caution |
| --- | --- | --- |
| Electric lime | Bright, unmistakable signal colour; strong for an SL mark and a selected step. | Must stay visually distinct from Royalty Sweep’s green. |
| Vivid cyan | Precise audio-instrument character and excellent separation from gold actions. | MOTION already uses cyan; this would need a deliberately distinct identity. |
| Signal yellow | Bold, easy to identify at small sizes and without a soft neutral cast. | Must remain distinguishable from the parent gold and warning colour. |

Recommend testing **electric lime** first. No separate splash is applied in this
round: the SL mark and active step use the approved gold. After a colour is
selected, apply it only to the SL monogram and active-step indicator. Never
change the black ground, neutral panels, white text, gold primary action or
status colours. These are proposals, not a claim of final brand approval.

### Actual logo and suite lockup

Each page embeds the actual SVG from V1
`static/img/streetbanker-logo-light.svg`, retrieved from `staging`. The source
asset’s corner paths, viewBox, period, wording, coordinates, stroke width,
letter spacing and embedded wordmark font are preserved. The source’s ivory
paint is normalized to **#FFFFFF only**, to obey the owner’s pure-white rule;
its explanatory source comment is omitted. Nothing is redrawn or substituted
with a new typed wordmark. The original asset is retained outside the commit as
verification evidence. The regular and dark files were inspected as well.

The header’s back link contains this wordmark and accessible text “Back to
Street Banker”. The suite lockup is a bracketed **SL**, **SONG LAB**, and
**BY STREET BANKER**. Stage uses its own ST/Stage lockup and the same parent
wordmark. Page titles and public suite references remain **Street Banker Song
Lab**. The logo’s original font is an asset-specific exception to the app font;
replacing it with Archivo would alter the actual mark.

### Archivo type and spacing

Google Fonts loads **Archivo 400, 500, 700, 800, 900** and **Archivo Narrow 700**.
Display titles use Archivo 900 with tight tracking, up to 88px on desktop;
section and panel headings use Archivo 800. Labels use Archivo Narrow 700,
uppercase and wide tracking. Body uses Archivo 400–500. Numbers use tabular
figures everywhere. No monospace. Minimum rendered text is 12px, including
scaled SVG labels. Buttons have a 48px minimum; other interaction targets remain
at least 44px. Emergency and performance controls are larger.

Spacing follows an 8px rhythm: 8, 16, 24, 32, 48 and 64px. Desktop margins are
64px; phone margins are 16px. Panels have 12px radii, a 1px top highlight,
inner shadow and subtle monochrome grain. The active panel has a gold hairline.
A single song hero dominates each page. Existing panels are grouped beneath
clear section headings with a named feature index, retaining every placement.

### The song and its instruments

Every page starts with fictional sample artwork, the huge white song title,
artist and exact version, then a full-width waveform with dense transient peaks,
subtle grey section bands, gold section markers/playhead and a time ruler.
The shape is deterministic fictional sample data with independent transients
and section-dependent intensity; it is not a sine-wave silhouette or a claim
that an uploaded recording was analyzed. The visible artist/song are fictional.

Every page also has the same labelled Sample/Example signal view:

| Instrument | Rendering and meaning |
| --- | --- |
| Segmented loudness/peak | LED-style segments; -60 to 0 dBFS [digital full-scale level] scale; gold high segments. Red is reserved for actual blocking clipping states. |
| LUFS | Large tabular -14.2 example readout; LUFS means perceived loudness. |
| Correlation | Left/right agreement from -1 to +1, with a sample stereo scatter and +0.62 marker. |
| Tonal balance | Gold mix curve against a pure-grey reference range, with a frequency ruler. |
| Energy | Section-aware intensity curve; sample shape and start/end times. |
| Key and BPM | Large example values with separate confidence rings; BPM means beats per minute. |
| A/B, in its existing feature home | Version identities, explicit Example matched-level badges and independent sample-note selectors. No audio is played or changed. |

These are displays of findings and comparison. Actual mixing/mastering stays
in The Rack. No processor controls are introduced in the combined suite.

### Actions and hardware selector

Each screen has exactly one gold primary action: solid #E8B950, black text,
48px height. Hover uses main gold; pressed uses deep gold. Secondary buttons
are white outlines. Disabled service operations keep readable text and an
explicit reason. Numbered step controls have raised hardware-key surfaces,
inner edges and a lit gold current state. They are not a plain tab rail.

### Phone and live performance

The three phone-specific pages retain their own narrow compositions even when
opened on a desktop. At 375px, the suite header stacks above the parent back
link; selectors use number-over-label keys; artwork and title form a compact
header; the primary action spans the column. Instrument groups stack as full
width glass displays, with readable HTML rulers where dense SVG labels would
become too small. No sideways scrolling or clipped feature text is permitted.

Performance has a persistent current-song/next-song safety bar, unmistakable
red emergency stop and immediate previous/next/click/preview-lock controls.
Large prepared-sound pads, a large tabular sample clock and BPM display supply
the stage-gear view. Both lock controls share sample state. Emergency remains
available while locked; anchor offsets clear the bar. Three-metre readability
must still be checked on the actual display during later implementation.

### Motion specification for later implementation

| Element | Normal motion | Reduced-motion / safety behavior |
| --- | --- | --- |
| Level meters | Real-value 20–50ms attack, 300–700ms decay, optional 1s peak hold. | No easing or glow pulses; readable measured numbers remain. |
| Playhead | Follow actual transport time while audio plays. | Discrete position/time updates; no automatic scrolling. |
| Panel reveals | 120–180ms opacity and at most 4px movement on deliberate disclosure. | Immediate reveal; preserve focus and reading order. |
| Version choice | Brief border transition, persistent selected label. | Immediate label/border change. |
| Performance | Stationary control positions; immediate emergency feedback. | Same stationary layout and immediate response. |

The static mockups do not simulate playback. CSS honors reduced motion; local
interactions change sample labels only. No save, upload, audio or provider runs.

## Live Lab inside Stage

Stage header: **Street Banker · Stage**. Enter through existing suite sign-in;
show set identity, current song, prepared scenes, package verification and one
large rehearsal/performance action. Performance has explicitly distinct selected,
queued and playing states, a persistent full-width emergency bar, huge current-song readout, click and lock
controls. The emergency stop remains reachable while inspecting lower panels;
preparation controls and recovery never start playback implicitly.
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
preview labs, no creation workstation promise. Owner-chosen name: Street Banker Song Lab (SL). Recommended but unapproved:
six-step layout, top-ten selection, linked-record identity and pilot thresholds.
Before code: Claude reviews this plan, verifies counterpart contracts, and the
owner explicitly approves the design/scope. Phase 0 ends at that review gate.

## Final pre-review corrections

Existing local upload/rights confirmation is Real. The proposed V1 Vault picker
and save connection is a separate Stub/Not built capability until the owning
services’ identity, ownership and file contracts are verified. The intake screen
and feature map label these separately. No local upload is represented as a
completed Vault connection.

Performance places previous/next song, click and preview lock alongside the
persistent emergency stop. These remain visible as the operator reads lower
sections; source-panel controls remain available. Both preview lock controls
share the same displayed state. Sample next/previous/click remain disabled while
no audio is loaded. Anchor offsets account for the safety bar’s actual height
so it does not cover the requested panel. Three-metre and hardware verification
remain later acceptance checks.
