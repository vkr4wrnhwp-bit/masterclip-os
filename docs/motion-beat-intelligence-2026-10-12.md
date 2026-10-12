# MOTION — Beat Intelligence Phase 2 (development only)

This is a stacked, MOTION-only draft on top of the separate native Quick Create PR #30.

## What the code really does
- Decodes project-authorized uploaded audio to real mono PCM, locally via FFmpeg.
- Measures a 20 Hz energy-onset envelope, autocorrelates candidate 60–180 BPM periods, estimates pulse phase and returns song-relative beat timestamps.
- Exposes estimated BPM, a conservative confidence score, waveform-aligned beat markers, and manually triggered **Snap start/end to beat** controls inside Quick Create.
- Refuses to invent a tempo for silent or insufficiently periodic audio. Snap controls are disabled when confidence is low.
- Stores a small bounded hash/version cache, rechecking current project rights before serving cached results.
- Makes no paid provider calls and does not alter the original track or submit a render.

## Explicitly not implemented
- Reliable instrument separation, meter/downbeat identification, bar grids, chorus/verse segmentation, musical transcription, tempo automation, lyric sync, speech transcription, an editable multitrack timeline or automatic multi-shot video assembly.
- Variable-tempo mapping and robust onset models for all music genres. Half/double-time interpretation may require human correction.
- Background worker processing for long-track beat analysis; the API currently performs an FFmpeg decode on request for tracks up to ten minutes and should be queued for production-scale concurrency.

## QA and release gates
- Real FFmpeg synthetic 120 BPM click-track test; silence should return no BPM; pure DSP fixture validates phase and timestamps.
- API-level tests require login, project rights, and deny revoked recordings even after a cached analysis.
- Review the branch's own typecheck/lint/test/build CI before calling this feature verified.
- Test real vocal-led songs, half-time hip-hop, swing, rubato, sparse intros and variable tempo against manually annotated beats.
- Run physical iPhone Safari and Android Chrome checks for grid readability, waveform performance, touch controls, seeking and audio mute conditions.
- This PR remains a draft stacked on PR #30; merging and deployment require separate owner approval after its base passes staging and mobile release gates.
