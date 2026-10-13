# MOTION Phase 7 — Scene Planning Intelligence

Development only; stacked on PR #35. No production deployment or cross-suite integration.

## Native workflow
1. Open a MOTION project and choose its **Music Video Timeline** tab.
2. Select a currently rights-authorized song, a time range, and the intended number of shots (1–12).
3. Enter a visual narrative direction. MOTION reads existing **artist-authored** section labels on that recording, if available.
4. Request a scene plan. The response provides timed shot concepts, suggested camera movement, performance direction, and visual treatment. Every idea is marked for human review.
5. The panel displays proposals only; dismissing them makes no changes. Actual video generation still uses MOTION's established canonical-shot creation, cost approval, provider routing and human review process.

## Product limitations
- The scene suggestions are deterministic creative templates, not a generative AI screenplay or automatic lyric understanding.
- MOTION does not infer choruses/verses. Structure annotations come from the artist, and unannotated passages use a neutral fallback.
- Planning does not write or update existing canonical shots, upload media, create a video, queue a render or incur charges.
- No external service or Street Banker Vault/Releases/Reach connection is implemented.
- Staging, real mobile, security and full latest-head CI are required before any release decision.
