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

## Surface design and graphic direction

Use V1 sb tokens read from `static/css/tailwind.css`: ground #0b0a08,
surface-1 #131110, ink #f2ece0, ink-2 #a99b84 and gold #c9a24a. The HTML
uses these exact values under sb token names, with off-white section bands.
Gold marks the primary action,
active step and selected version. Avoid gold body paragraphs, rainbow status
badges, fake “pro” meters, stock mixing-console imagery and decorative graphs.
Status always has words; red appears only for an actual blocker/emergency.

### Material, hierarchy and typography

The song is the hero on every screen: original geometric sample artwork, title,
version and a complete waveform, followed by one obvious next action. Surfaces
use layered anodized charcoal, restrained gold edge light, inset meter glass,
soft grain, bevel highlights and deep inner shadows. Warm white section bands
separate the four tool-page stages. This is an original Street Banker system;
no competitor branding, layout or copy is borrowed. Red is reserved for a
blocking delivery example and emergency controls, never decoration or progress.

Display: **Barlow Condensed**, weight 600–700; UI: **Manrope**, 400–800.
Google Fonts is optional; Nimbus Sans Narrow/Arial Narrow and Arial are usable
fallbacks. No monospace. Desktop title 61px, performance title 88px, section
27px, body 15px, description 14px, supporting text and graph labels at least
12px. Phone title 38px; performance title 46px. Numbers use tabular figures.
SVG instrument labels are sized to remain at least 12 screen pixels; the phone
waveform uses a separate readable HTML section/time legend.

### Instruments tell the truth

All instruments and artwork are original inline SVG/CSS, labelled **Sample** or
**Example**. Waveform bars, section boundaries, energy envelopes, scatter shapes
and tonal curves use plausible deterministic shapes; they are not measurements
of a supplied recording. A later implementation must replace them with actual
saved analyzer output and its source/version, never infer results from styling.

| Instrument | Purpose and truthful rendering |
| --- | --- |
| Complete waveform | Whole-song amplitude shape, section bands, times and section markers; a static sample playhead. |
| Energy curve | Changes in intensity through the song with a labelled relative scale; human section corrections remain authoritative. |
| Key and tempo | Readout with separate sample confidence values; musical key and BPM [beats per minute] are explained. |
| Loudness and peak meters | Stereo bars, numerical values and a -48 to 0 dBFS [digital full-scale level] scale; LUFS [perceived loudness] clearly named. |
| Stereo field | Correlation [how similarly left and right move] scale from -1 to +1; sample spread is diagnostic context, not an editing control. |
| Tonal balance | Your mix and reference curves on a frequency scale; no unmeasured pass/fail claim. |
| A/B players | Exact version identities and **Example matched-level** badges; preview controls select notes only and never play or normalize audio. |

The finishing brief combines Mix Doctor, references, Translation Lab and Artist
Sonic DNA findings. Actual mix/master processing hands off to The Rack. Rack
intent chains, presets and history remain a brief and evidence record, not a
second processor. Rights, record history and engineer requests remain reachable.

### Every feature has a visible home

[FEATURE-MAP.md](FEATURE-MAP.md) maps all 19 principal inventory surfaces,
77 named capabilities and every one of the 100 existing Card-panel occurrences.
Each source panel has a named visible subpanel and an HTML anchor. Status badges
separate **today’s source assessment** (Real / Needs a key / Sample / Stub) from
**this display** (always Sample). The chrome calls Stub “Not built”. Mixed
surfaces explain exceptions rather than claiming a provider or handoff works.
No migration may replace the preview until this crosswalk is satisfied for
controls, permissions, saved records and the actual counterpart contracts.

The original ten HTML files are all redesigned. Seven additional screens show
Benchmark/A&R; Experiments/Producer; the finishing brief; Collaborate; handoffs,
memory and requests; Live MIDI/settings; and full Live performance. The README
links all 17. A&R remains server permission-gated. Comments, collaborators,
approvals, Record Passport, rights and provenance are explicit panels, not
implied future items behind the ten research proposals.

### Phone composition and accessibility

The three dedicated phone views recompose home, the song and Stage around one
column, a compact artwork/title group, full-width next action, a short step grid,
and readable stacked instruments. All screens also adapt to 375px. Preparation
pads become two columns. Tables become labelled blocks; no sideways tab rail.
Controls, links and help summaries are at least 44px tall; performance controls
are 72px or larger. Keep long text wrapping and visible keyboard focus. Do not
hide content overflow to conceal a layout failure. Every section has “?” help,
with the feature checklist, Walkthrough and Back to Street Banker in the chrome.
All new external service operations are disabled with a reason in the mockup.

### Motion specification for later implementation

| Element | Normal motion | Reduced-motion / safety behavior |
| --- | --- | --- |
| Level meters | 20–50ms attack, 300–700ms decay; optional peak hold about 1s, driven by real audio values. | Remove easing and glow pulses; retain readable numerical values and deliberate updates. Never fabricate activity. |
| Playhead | Follow actual transport time; interpolate only between measured positions while audio plays. | Discrete position/time updates; no decorative sweep or automatic scrolling. |
| Panel reveal | 120–180ms opacity and at most 4px movement after deliberate disclosure. | Immediate reveal with no movement. Preserve focus and reading order. |
| Version choice | Brief border change, persistent selected label and aria-pressed state. | Immediate label/border change, with no flashing. |
| Performance | No continuous decorative motion, changing layout or delayed emergency feedback. | Same stationary layout; emergency state updates immediately. |

The current static HTML does not simulate playback. CSS honors
`prefers-reduced-motion`; local interactions change sample notes/state only.
Future meter animation must stop when the page is hidden or transport stops.

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
