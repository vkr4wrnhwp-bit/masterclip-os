# Artist Voice Vault

Governed storage of verified, authorized artist voice identities. This is not
an open voice-cloning marketplace, and it does not become one by accident:
the only registration path the adapters accept is an **owner-verified
external reference**.

## Registration model

1. The artist creates/verifies the voice through the provider's official
   verified-voice process **themselves**.
2. The artist shares the resulting provider voice reference with Street
   Banker.
3. Street Banker confirms the reference exists, records its verification
   state, and stores the reference plus a consent record and a permission
   scope. The underlying voice model is never possessed or exportable here.

A manager, label, or partner cannot upload an artist's voice and claim
consent: the `provider_verification`-by-proxy mode is refused by both the
ElevenLabs and mock adapters (`voice.owner_verification_required`), and
registration without the owner-consent acknowledgment or a provider
reference is refused by the service.

## Permission scope

Stored per profile: owner, permitted uses (commercial, advertising, dubbing,
social, internal, sublicensing), channels, territories, languages, projects,
validity window, and the consent record. Every generation that names a vault
profile passes `requireUsable(profile, use, now)`, which refuses — with the
specific reason — voices that are revoked, expired, not yet valid,
unverified, or not permitted for the requested use.

## Prohibited uses

False endorsements, contract acceptance, banking or identity authentication,
political messaging, defamation, statements the artist did not authorize,
perpetual use without consent, cross-tenant reuse, training any shared model,
and marketplace listing. These are not configuration options; the code paths
do not exist.

## Revocation

Revoking a profile immediately: blocks new generation, revokes the linked
consent record, flips every asset generated with that voice to
`rights_review_voice_revoked`, requests provider-side voice revocation where
supported (a provider failure there never resurrects the voice locally), and
writes the audit trail. Audit records are preserved — revocation removes
capability, not history.
