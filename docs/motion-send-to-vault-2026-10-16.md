# Send to my Vault

Owner, October 16: "make sure everything saves or uploads to the Vault".

Each signed-off master on the Masters page has a "Send to my Vault" button. It
files the master's video in the artist's Street Banker Vault as a video named
"<film title> – <master name>". The state line under it reads "Sending…",
"Saved to your Vault: <name>" or "Already in your Vault".

## What goes, and when

- Only a signed-off master: promoted by a person, not archived, and its output
  still carries that person's approval. Nothing is auto-promoted
  (docs/architecture.md), so nothing reaches the Vault without a person.
- Only in a project the signed-in account directs (the same director check the
  other masters routes use), and only in a session Street Banker's hand-off
  opened. A MOTION password session never reaches anyone's Vault.
- The file is the finished master when one was rendered, else the approved
  original. MP4 or MOV only, up to 200 MB (the Vault's own limit for video).
  A bigger file is refused before it is read and before Street Banker is asked.
- Once per master. The Vault file id is kept on the master (migration
  0010_master_vault_delivery adds vault_file_id, vault_label, vault_sent_at), so
  a second press says "Already in your Vault" and sends nothing. If the Vault
  already held the same bytes, Street Banker says so and nothing is added twice.
- If Street Banker refuses or does not answer, nothing is sent and the master
  is left exactly as it was. The artist sees one plain sentence.

## How it talks to Street Banker

`GET /suites/token?suite=motion&scope=deliver` with `Authorization: Suite
<proof>`, then `POST /api/vault/deliver` with the deliver token: multipart
`file`, `kind=video`, `label`, `source=motion`. The proof is signed after the
file has been read, so a token is never spent on a file that cannot go.
Routes: `GET /api/vault/status` (whether the button can show) and
`POST /api/masters/:masterId/vault`.

## Settings

No new setting. It uses the Vault door MOTION already has for "From your
Vault": `SUITE_SSO_SECRET` (the key Street Banker holds for "motion") and
`STREET_BANKER_URL` (default https://app.streetbankermusic.com). With
`SUITE_SSO_SECRET` empty the button does not show and the route answers "The
Vault is not switched on for Motion yet." Street Banker's side must accept
suite "motion" with scope "deliver" and kind "video" (vault_doors_api.py).

## Not covered yet

Song-moment and captioned MP4s, delivery-format renders and delivery packages
are not sent on their own; only the master itself is.
