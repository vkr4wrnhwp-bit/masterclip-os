# Security model

---

## What we are protecting

1. **Provider credentials.** They spend money.
2. **The spend authorization itself.** A bug in routing must not be able to run
   up a bill.
3. **Likeness and consent.** Reference packs of real people.
4. **Unreleased footage.** Client work before it ships.
5. **The audit trail.** Who approved what, and what it cost.

## Who we are protecting against

| Actor | Capability assumed |
|---|---|
| Anonymous internet | can reach the public API surface and any webhook endpoint |
| Authenticated org member | can reach every project they are a member of |
| A provider (or anyone spoofing one) | can POST to our webhook endpoints |
| A malicious upload | controls filename, declared MIME, and file bytes |
| A malicious prompt | controls every string that reaches ffmpeg and the database |
| A compromised database backup | has every row, but not the process environment |

---

## Controls, and where they live

### Credentials

- Provider keys are read from the environment **server-side only**. No key is
  ever serialized to the browser; `/api/providers` returns a masked fingerprint
  (`abcd…yz (32 chars)`), never the key.
- `registerSecret()` records every live secret value at boot, and the logger
  passes every field through `redact()` — which scrubs both by **key name**
  (`authorization`, `api_key`, `token`, `secret`, …) and by **registered value**,
  so a key echoed back inside a provider error message is still scrubbed.
- Outbound URLs are logged with their query strings stripped, because signed
  provider URLs carry tokens there.
- `pnpm lint` fails the build on a committed AWS key id, Anthropic key,
  Google API key, private-key block, or literal bearer token, and on a
  `.gitignore` that does not ignore `.env`.

### Spending

- **Nothing reaches a provider's `submit()` except through the cost controller.**
  `RenderService.submitRender` is the only caller, and it cannot get there
  without an `authorize()` that returned `allowed`.
- Authorization runs **twice** — at plan time and again at submit time, because
  jobs wait in a queue while prices move and other jobs spend the budget.
- `MASTERCLIP_MODE=sandbox` (the default) refuses every billable submission
  outright, independent of budgets.
- `LIVE_SPEND_CAP_USD` is a global ceiling across every org and project, checked
  last and separately, precisely so a routing bug cannot spend at scale.
- Premium-tier renders and estimates above the project threshold require an
  explicit human approval flag; an agent cannot supply it —
  `assertCanApprovePremium` restricts that to the cost controller agent, and even
  that only produces a recommendation.
- `cost_ledger` and `audit_log` are append-only. Nothing in the codebase updates
  or deletes a row in either.

### Sessions and authorization

- Passwords: **scrypt** with a per-user salt, timing-safe comparison. Login runs
  the KDF even for an unknown email so response timing does not enumerate
  accounts.
- Sessions are opaque random tokens; only their **SHA-256** is stored. A database
  leak does not hand out live sessions.
- Cookies are `httpOnly`, `sameSite=lax`, and `secure` when
  `NODE_ENV=production`.
- Project access is checked on **every** project-scoped route via
  `requireProject`, which also verifies the project belongs to the caller's org.
  Roles ladder `viewer < editor < director < producer`; spending money and
  promoting masters require `director` or above.
- The first account bootstraps the org; after that `/api/auth/signup` refuses.

### Webhooks

Three independent defences, because provider webhook security ranges from signed
to nothing at all:

1. **Our own HMAC token in the callback URL**, bound to `(providerId, jobId)`, so
   a token minted for one job cannot authorize another.
2. **Per-provider signature verification** where the provider offers one
   (Replicate). Verification runs against the **raw request body** — the JSON
   content-type parser stashes the exact bytes, because re-serializing parsed
   JSON changes them and breaks every HMAC. A timestamp window rejects replays.
3. **A dedupe key** on a unique `(provider_id, dedupe_key)` index, so a
   redelivered webhook is acknowledged and ignored rather than driving a second
   ingest.

Even then, a webhook is treated as a **wake-up signal only**: authoritative state
is re-fetched from the provider before anything is recorded or spent. That is
what makes an unsigned MuAPI or fal callback safe to accept.

### Uploads

- Type is decided by **magic-byte sniffing**, not the declared `Content-Type` or
  the filename — both are attacker-controlled. Anything not on the allow-list is
  rejected.
- Filenames are stripped of directory separators, traversal, and leading dots.
- Object keys are **constructed** from `(projectId, kind, assetId, filename)`,
  never taken from input, and the local driver additionally resolves and rejects
  any key that escapes the storage root.
- Size limits: 512 MB per file, **one file per request**, 32 MB JSON bodies. A
  request carrying several files is refused rather than silently storing the last
  one, which is what it used to do.
- Content-addressed dedupe by SHA-256 means the same upload is stored once.

### Serving media

The only route that returns bytes is `/api/assets/raw`, and it requires a valid
HMAC over `(key, expiry)` plus an unexpired deadline. A raw storage key is not
enough. Signature and expiry failures are indistinguishable in timing.

### Command execution

Every ffmpeg and ffprobe invocation goes through `run()` in
`packages/media-tools/src/runner.ts`, which uses **`execFile` with an argv
array** and `shell: false`. There is no string-command variant to reach for.
Prompts, character names, and filenames all flow through this layer and any of
them can contain quotes, semicolons, or backticks; an argv array makes shell
metacharacters inert by construction. `pnpm lint` fails the build if
`packages/media-tools` ever uses `exec()`.

The one place a path is written into a file rather than an argv slot is the
concat demuxer list, where paths are single-quoted with embedded quotes escaped,
and the list is written by us and deleted afterwards.

### SQL

Every query uses bound parameters. The only interpolated values are `LIMIT`
counts (passed through `Math.floor`) and table/column identifiers, which come
from literal strings in the code and are additionally validated against
`/^[a-z_][a-z0-9_]*$/i` by `assertIdent`. `pnpm lint` flags SQL that interpolates
anything else.

### Signed asset links

Asset bytes are served only through `GET /api/assets/raw`, which takes no session
and no cookie: the URL carries an HMAC over the key and an expiry, compared
timing-safely. The signature is anchored to a **window boundary** rather than to
the instant it was generated, so the same key yields a byte-identical URL for
every request inside that window. That is a caching property, not a security
one — an unstable URL changes on every response, which makes the browser
re-download every clip in the review grid each time a decision reloads it — but
it is worth stating here because it bounds link lifetime: a link is signed as of
the start of its window, so it lives between half and all of the requested TTL,
and never longer.

### Cross-site request forgery

State-changing requests that ride on a session **cookie** must clear two
independent checks. Either alone has a gap the other covers.

1. **Origin.** `Sec-Fetch-Site` is written by the browser and cannot be forged by
   page script; anything but `same-origin` or `none` is refused. `Origin` is
   checked against the request host as a fallback for engines that omit
   `Sec-Fetch-Site`. This stops the classic cross-site POST outright.
2. **A session-bound double-submit token.** The server issues
   `masterclip_csrf` — deliberately *readable* by script, because the SPA has to
   echo it into an `x-csrf-token` header, and setting a header is precisely what
   a cross-site page cannot do. The token is `nonce.HMAC(SESSION_SECRET, nonce.sessionToken)`.
   `SESSION_SECRET` is refused at startup in production if it is absent, is the
   value published in this repository, or is under 16 characters — otherwise the
   HMAC would be computed with a key anyone can read. The session cookie itself
   is an opaque random token, not derived from this secret, so rotating it
   invalidates outstanding CSRF tokens but logs nobody out.

The binding in (2) is the part that matters. Plain double-submit — "cookie and
header must match" — is forgeable by anyone who can *write* a cookie on the
domain, including a compromised sibling subdomain: they simply choose both
halves. Tying the token to the session token means forging a pair that verifies
requires the victim's session, which a cookie-writing attacker does not have.

Three exemptions, each deliberate:

- **Requests with no session cookie.** Nothing to ride on.
- **Login, signup and logout.** These keep the origin checks but are not asked
  for a token. The gate keys on the session cookie being *present*, not valid,
  so a stale cookie — an expired session, a reset database, a token from a
  previous deployment — would otherwise 403 all three, and the endpoints whose
  job is to repair a broken session cannot be the ones a broken session locks
  you out of. They are throttled instead (below).
- **`Authorization: Bearer` callers.** Not cookie-driven, so a browser cannot be
  induced to make one on a user's behalf. The CLI depends on this path.
- **`/api/webhooks/*`.** Server-to-server, no cookie, no browser `Origin`. Their
  authentication is an HMAC token in the callback URL — demanded
  **unconditionally** by the route — plus a per-provider signature over the raw
  body. That check used to run only when the caller supplied a `job` query
  parameter, which made it opt-in for the one party it defends against: omitting
  the parameter skipped it entirely and left an anonymous write path into
  `webhook_events` with an attacker-chosen dedupe key, enough to pre-poison a
  genuine redelivery into being dropped as a duplicate. It now fails closed.

The token is issued at login and signup, and re-issued on `GET /api/auth/me`,
which the SPA calls at boot. That last one is what stops a session created before
this release from being permanently unable to mutate anything.

### Rate limiting

An in-process token-bucket limiter (`RateLimiter` in `@masterclip/shared`) runs in
an `onRequest` hook — ahead of body parsing, so a refused caller never gets to
hand the server a 32 MB payload to parse. Budgets are per client address:

| Class | Budget | Covers |
|---|---|---|
| `auth` | 10 / 15 min | login, signup |
| `authAccount` | 5 / 15 min | login, keyed by **(email, address)** |
| `authAccountGlobal` | 50 / 15 min | login, keyed by **email** alone |
| `upload` | 60 / hour | asset upload |
| `render` | 120 / hour | anything that can put a paid generation on the wire |
| `preview` | 600 / hour | pricing previews, which spend nothing |
| `mutation` | 240 / 5 min | every other state change |
| `read` | 1200 / 5 min | reads, including the queue view's poll loop |
| `webhook` | 1200 / min | provider callbacks |

The two account budgets exist because a per-address limit does nothing against a
botnet spreading its guesses for one mailbox across a thousand addresses — but
the obvious fix, an email-only budget, is an account-lockout weapon: anyone who
knows your address spends your five guesses and *you* get the 429, held open
forever for five requests every fifteen minutes. So the tight budget carries the
address as well, and the email-only backstop sits far above any single
attacker's reach (each address is separately capped at 10 by `auth`). Proving the
password refunds both, so four typos does not leave a real user one attempt from
lockout.

Pricing previews get their own budget rather than sharing `render`. Sharing one
meant a producer iterating in the cost lab — the exact behaviour this system is
built to encourage — spent the allowance the submission needed, and the refusal
then landed on the submit rather than the preview: the worst possible ordering.

Classification happens on the **decoded** path, because the router matches on the
decoded path: `POST /api/shots/x/%72ender` reaches the render handler, and a
classifier reading the raw target would bill it to the far cheaper `mutation`
budget. Retries and dead-letter replays count as `render` — each submits a new
billable generation.

A token bucket rather than a fixed window because a fixed window lets a caller
spend a full budget in the last millisecond of one window and a full budget again
in the first millisecond of the next — twice the intended rate at exactly the
moment it matters.

Two details that are easy to get wrong and are tested:

- **Refused requests do not consume tokens.** Otherwise a client in a tight retry
  loop would hold itself out indefinitely.
- **Eviction is by fullness, not recency.** The bucket map is capped so that key
  rotation cannot exhaust memory, but evicting the *least recently used* key
  would let an attacker erase their own penalty by making noise from a few
  hundred fresh addresses. A full bucket carries no information; an empty one
  carries all the enforcement, so the fullest go first.

Being in-process, this bounds abuse against one instance. It is defence in
depth, not a cluster-wide quota — see the gaps table.

### Trusting the proxy

`trustProxy` is **off by default** (`TRUST_PROXY=true` to enable).
`X-Forwarded-For` is written by the client, so trusting it on a directly exposed
port lets anyone choose their own source address — which poisons the audit trail
and makes every IP-keyed limit above decorative. Turn it on only when the API
genuinely sits behind a proxy that overwrites the header.

### Rights and consent

`requireAuthorizedForIdentity` refuses unless every reference in the pack is
explicitly `authorized`, has recorded consent, and has not expired. The failure
mode this prevents is generating a real person's likeness because someone dropped
a photo in a folder. Rights changes are written to the audit log.

---

### Live performance data

Live Lab moves audio out of the server and onto a performer's device, which is
the point — a show cannot depend on the network — and it changes what has to be
true.

- **Every Live Lab table is organization scoped**, and reads filter on `org_id`
  in SQL rather than trusting the caller. Writes additionally check that a set
  item, scene or asset belongs to the *project* being written to, not merely to
  the same organization: same-org cross-project writes are refused, because a
  manifest that references a set item absent from its own setlist is a broken
  show, not a permissions curiosity.
- **Entitlements are enforced server-side on every route**, before the body
  runs, with numeric limits checked where the limited resource is created.
  Hiding a nav item is a courtesy, not a control.
- **Rights confirmation gates AI processing** at the API boundary *and* again at
  the provider boundary, so a future caller cannot skip it. Generated audio
  carries lineage — source, provider, model, prompt, settings, and the human who
  approved it — and nothing enters a set without that explicit acceptance.
- **Cached shows are unencrypted on the device.** A performance package is
  plain audio in IndexedDB, readable by anything with access to that browser
  profile. That is the correct trade for playback that cannot fail, but it means
  a shared or borrowed laptop should not hold an unreleased record. Clearing
  site data removes it.
- **Package downloads use the same signed, expiring asset URLs** as the rest of
  the system; a raw storage key is never enough, and the manifest records
  checksums so a tampered cache fails verification rather than plays.

## Known gaps in this release

Stated plainly rather than left to be discovered:

| Gap | Impact | Mitigation today |
|---|---|---|
| Rate limiting is per process, not per cluster | behind N API instances the effective budget is N times the configured one | run one instance, or put a shared limiter in the proxy in front; see "Rate limiting" above |
| `SECRETS_ENCRYPTION_KEY` is defined but unused | the `provider_credentials` table exists for per-org keys; this release reads keys from the environment only | keys live in the environment, not the database |
| S3 driver unexercised against a live bucket | signing is unit-tested against AWS's published vector, but no end-to-end run | run `masterclip doctor` with `STORAGE_DRIVER=s3` before relying on it |
| No per-user MFA or invite flow | first account bootstraps, others are created by an owner | keep the deployment private |
| Session revocation is per-session | no "sign out everywhere" | delete rows from `sessions` |
| Cached performance packages are unencrypted on the device | plain audio in IndexedDB, by design, so playback never depends on a key or a network | do not cache unreleased material on a shared machine; clear site data after a show |
| Live Lab prompt safety is pattern matching | blocks imitation/cloning/protected-song phrasing at two layers, but is not a classifier | a real audio provider must add its own policy check behind it |

## Reporting

Security issues in this codebase should go to the repository owner privately
rather than through a public issue.
