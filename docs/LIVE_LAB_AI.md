# Live Lab AI Scene Builder

The AI layer generates *performance sections* — intros, breakdowns, transitions,
risers — from material the artist owns. It mirrors the video side's provider
architecture: a narrow interface, a registry, and a mock that produces real
output so the entire pipeline runs with zero credentials.

## Provider layer (`@masterclip/ai-audio`)

```ts
interface AudioIntelligenceProvider {
  id: string
  displayName: string
  available(): boolean
  generateScene(input: SceneGenerationInput): Promise<SceneGenerationResult>
}
```

- `MockAudioProvider` (`mock-audio`, the default) renders three genuinely
  different, tempo-locked WAV options per request with the local synthesizer —
  free, offline, deterministic per seed. It is always registered, so Live Lab
  works with no credentials and no audio platform at all.
- `PlatformMusicProvider` (`platform:<providerId>`) bridges onto the platform's
  music slot from Audio Intelligence — ElevenLabs when a key is configured, the
  platform mock otherwise. Registered automatically when the build composes the
  audio layer, and selected with `LIVE_AI_PROVIDER`.

The bridge describes the composer *structurally* rather than importing
`@masterclip/audio-core`, so `ai-audio` stays portable to the desktop build
instead of dragging the whole audio platform with it.

**Length is requested exactly; grid alignment is not guaranteed.** The section
length is computed from bars and BPM and passed as `music_length_ms`, but a
generative music model is not a click-locked renderer. Every option generated
this way says so in its description — *check against the click before use* —
because a bar that drifts is discovered on stage otherwise.

## The workflow

1. The artist selects a song and, optionally, owned source audio (only assets
   with a recorded rights confirmation are offered).
2. They describe the scene and choose bars, tempo behavior, energy,
   instrumentation, intended transition.
3. They confirm rights: *"I confirm that I own or control the audio I am
   uploading, or have authorization from the rights holder to use it."*
4. `POST /api/live-lab/projects/:id/ai-scenes` creates the job and enqueues
   `live.ai.generate` on the durable queue — generation **never** runs inside
   an HTTP request, and the show stays fully usable while it cooks.
5. The worker runs the provider, stores each option as a live asset, and marks
   the job READY → the workspace shows **NEW SCENE READY** with OPTION A/B/C,
   preview players, and accept/discard actions.

## Hard rules (enforced, and tested)

- **Rights confirmation is a gate, not a checkbox.** The API refuses jobs and
  uploads without it; the worker refuses source assets whose rights were never
  confirmed; `assertGenerationAllowed` re-checks at the provider boundary so a
  future caller cannot skip it.
- **Real-person imitation is refused.** `checkPromptSafety` blocks style-of /
  sounds-like / type-beat phrasing, producer name-dropping, voice cloning, and
  protected-song recreation ("AI cover of…", sampling by title). Heuristic and
  deliberately over-cautious: a blocked prompt can be rephrased with neutral
  musical descriptors; an imitation that ships cannot be unshipped. A hosted
  provider should add its own policy check behind this floor.
- **Nothing is ever replaced automatically.** Generated options land as new
  assets. Accepting (`POST /ai-jobs/:id/accept`) is the only path into the set:
  `add_scene` creates a scene, `replace_scene` swaps a scene's clip reference,
  `assign_pad` binds a pad — all explicit, all human. The integration tests
  assert the existing scene's clips are byte-for-byte untouched by generation.
- **Lineage is preserved.** Every generated asset stores
  `GenerationLineage`: source asset/version, provider, model, prompt, settings,
  generation time, rights confirmation, and human approval (`approvedBy` /
  `approvedAt`, filled in at accept time).
- **Usage is metered and budgeted.** Two limits apply, and both must pass.
  `live_lab.max_ai_generations_per_month` bounds how *often* an org may
  generate; the organization's audio budget bounds how much it may *spend*.
  Live Lab spend lands in `audio_usage_ledger` like every other audio
  purchase, so exhausting the budget through Meeting Intelligence or Song Lab
  stops scene generation too — the budget is the platform's, not each
  feature's.

  The budget is checked twice, deliberately:

  1. **At submission**, before the job row exists, so an exhausted org gets a
     `402` with `live.budget_exhausted` rather than a queued job that fails
     somewhere it cannot see.
  2. **Before the provider is called.** These jobs are asynchronous by
     construction, so several submitted at once would each clear the first
     gate while the budget still looked intact and then run together — each
     affordable alone, the batch not. This is the check that actually holds
     the line; the render pipeline re-authorizes before submitting for the
     same reason.

  A scene is quoted at `SCENE_OPTION_COUNT` takes, so a generation that would
  push *past* the cap is refused as well as one submitted after the cap is
  already gone. A soft budget (`hardStop: false`) warns and allows, as
  everywhere else on the platform. A refusal at generation time marks the job
  `failed` with the budget reason rather than throwing at the worker, which
  would take the queue down with it.

## Background generation during rehearsal

The current scene remains playable while a variant generates; when READY, the
artist previews and chooses: replace, keep both, or assign elsewhere. This
falls out of the job model — there is no special case.

## Experimental NEXT SCENE mode

Not enabled in production, deliberately. The architecture it needs is already
the architecture that exists: a generated scene becomes triggerable **only**
after it is fully downloaded, checksum-verified, and cached (package rules in
[LIVE_LAB_OFFLINE.md](LIVE_LAB_OFFLINE.md)), and the currently playing scene
never depends on generation. A future NEXT SCENE UI is a scheduler over these
same primitives — showing GENERATING → READY and gating the trigger on READY —
not a new audio path.
