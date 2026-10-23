# Job 35 — Song Lab shell and owner service setup

No Render service or setting was created or changed. Claude creates the service after review.
The owner's Job 35 authorizes Phase 1 implementation, superseding Phase 0's documentation-only restriction.

## Render settings

| Setting | Exact setting |
| --- | --- |
| Repository | vkr4wrnhwp-bit/masterclip-os |
| Branch | codex/songlab-shell-20261023 (reviewed Job 35 head) |
| Runtime | Docker |
| Dockerfile path | ./Dockerfile |
| Docker build context | . |
| Docker command | Leave blank: existing CMD runs node scripts/serve.mjs |
| Health check | /api/health |
| Auto deploy | Off |
| Disk | New disk for this service only; mount /var/data. Never attach Motion's disk or database. |

The Docker command honors Render's PORT automatically. Existing API and worker processes run together.
Schema migrations are additive; the suite skips demo/password account seeding. Both new flags remain off until owner setup is reviewed.

| Environment name | Default / owner setup |
| --- | --- |
| NODE_ENV | production (Docker) |
| MASTERCLIP_MODE | sandbox (Docker; no provider billing) |
| API_HOST | 0.0.0.0 (Docker) |
| API_PORT | 4310 (PORT overrides at startup) |
| TRUST_PROXY | 0; owner may set 1 only behind Render's trusted proxy |
| SONG_LAB_SUITE_ENABLED | 0 |
| SONG_LAB_SUITE_SUITE_SSO_ENABLED | 0 |
| STREET_BANKER_URL | https://app.streetbankermusic.com |
| PUBLIC_BASE_URL | blank; resolved from RENDER_EXTERNAL_URL |
| SESSION_SECRET | blank; required server secret in production |
| ASSET_SIGNING_SECRET | blank; required server secret in production |
| SUITE_SSO_SECRET_SONG_LAB | blank; dedicated Song Lab key, matching V1 only |
| DB_DRIVER | sqlite |
| SQLITE_PATH | default var/masterclip.sqlite; set /var/data/song-lab.sqlite with the disk above |
| DATABASE_URL | blank; unused with sqlite |
| STORAGE_DRIVER | local |
| STORAGE_LOCAL_ROOT | default var/storage; set /var/data/storage with the disk above |
| SONG_LAB_ENABLED | 1; retain existing capabilities |
| STUDIO_ENABLED | 1; retain existing capabilities |

Provider configuration is unchanged. Missing keys stay missing, existing default-off features stay off;
this PR neither enables paid providers nor claims Vault/Rack connectivity.

V1 owner setup, after service health and end-to-end sign-in review:

| Environment name | Default / setup |
| --- | --- |
| SUITE_URL_SONG_LAB | blank; blank means Soon, including for the owner |
| SUITE_SSO_SECRET_SONG_LAB | blank; same dedicated Song Lab key as the new suite service |

Song Lab always uses a POST handoff, without requiring a change to the other suites' SUITE_HANDOFF_POST list.
Wire key: song-lab. Local registry identity: song_lab_suite. Motion's key, identity, branch and service are never used.

## Security and compatibility

Ported from motion-live packages/auth/src/suite-sso.ts, verified source blob
75705ed21a4245459c5870dce6e9c3fc49360d5b. The itsdangerous wire format and salts are retained.
Added required uid/nonce, bounded inflation, browser state, seat validation and dedicated-key-only verification.
Nonce consumption lives in a database unique key, so replays fail across restarts/processes.

Pro and Label are checked from the signed claim on the server. Artist/Fan get a locked door with Upgrade.
A team seat follows the artist's plan and must include Studio (or all rooms); its read/edit permission is enforced
on the server. Acting-partner tokens are refused until an authorized partner contract exists.
Each parent artist uid has a separate local organization. A seat uses that artist's organization, with its own
actor id. Email is a display/contact field, never a tenant lookup. Original project IDs and histories are untouched.
Ordinary partner capabilities are granted; internal A&R and proprietary cohorts remain explicit grants.

Sessions are opaque HttpOnly cookies with a 15-minute maximum, requiring another parent handoff at expiry.
Plan/seat changes take effect on that next handoff, at most 15 minutes later; immediate parent revocation polling
is not implemented in this phase. The requesting browser's state cookie is HttpOnly, Secure and SameSite=None
for the cross-site POST. Production HTTPS is required. Browser storage receives no sign-in token or identity.
No password signup/login, bearer or legacy local sessions open the enabled suite. Existing CSRF checks protect
mutations; only the exact handoff receiver uses its signed token plus browser state instead.

Flag off preserves legacy screens/auth/entry hashes. The HTML records the server's entry flag so offline cached
Live Lab reloads select the same shell. With the flag on, six steps wrap the existing Song Lab/Studio screens;
no linked records, new mixer, Stage move, Rack handoff or Vault handoff is implemented. Live Lab remains reachable
on its existing hashes until Phase 4. The feature checklist contains the complete existing 78-feature inventory.
