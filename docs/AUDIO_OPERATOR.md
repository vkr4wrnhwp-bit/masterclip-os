# Street Banker Operator

A 24/7 intake agent backed by real Street Banker operators. It explains
services, qualifies distribution leads, collects contact and catalog
information, creates Operator Desk leads, and hands over to humans. It is
deliberately narrow — an orchestrator plus scoped specialists
(distribution, royalty, platform support, partnership), never one
uncontrolled general-purpose agent.

## What the agent may and may not do

May: explain services and lanes, qualify leads, collect artist/catalog/
distributor/release/goal information, ask whether audio is owned, explain the
application process, create leads and notes, schedule human callbacks, route
support questions, transfer to a human.

Must not — enforced by server-side guardrails on every outbound reply
(`screenAgentReply`), not by prompt hope: promise acceptance or funding,
approve deals, negotiate binding terms, give legal interpretations, guarantee
streams/playlists/PR/royalty recovery, state that an artist is definitely
owed money, reveal internal scoring or another artist's data, or process
sensitive account changes. A screened violation is replaced with a safe
correction and logged. Requests for commitments ("will I be approved?",
"guarantee me…") get a boundary statement routing to the human team.

## Disclosure

Before interaction the user sees, and the conversation record stores: that
they are speaking with an AI-powered Street Banker assistant, that the
conversation may be recorded/transcribed if enabled, that a human can be
requested at any time, and that the agent cannot give legal advice or approve
deals. Disclosure text and version are stored on the conversation from turn
zero.

## Human escalation

`detectEscalation` triggers a transfer on: an explicit ask for a human, legal
interpretation, financial disputes, negotiation attempts, distress signals,
or sensitive account changes. A transfer ends the agent conversation,
creates/updates the lead, and files a priority callback task. Detection is
deliberately generous — a false transfer costs an operator minutes; a missed
one costs trust.

## Tools

All tool effects are server-side, authenticated, validated, audited, and
tenant-scoped: lead creation/update, follow-up tasks, human callback,
transfer, end conversation. When the ElevenLabs agent runs the voice channel,
tools are declared as *client* tools — the provider sees names and JSON
schemas only, never credentials or database access.

## Knowledge base

Tenant-isolated documents per agent (approved public content, FAQs, policies,
onboarding guides). Never: private deals, unapproved contracts, cross-tenant
data, private artist files, or flagship strategy. Versioned; version recorded
on the agent.

`POST /api/audio/agents/:id/sync` (admin) queues `audio.agent.sync`, which
pushes the definition to the configured conversational-agent provider: each
knowledge doc becomes a provider KB text document attached to the agent's
prompt, the disclosure travels in the system prompt, tools are declared as
client tools, and the resulting provider agent id is recorded. Re-syncing
updates the same provider agent in place.

## Post-call processing

Provider-hosted conversations complete via the verified post-call webhook:
fetch the conversation, store the transcript (recording only where policy
allows), classify (intent, lead quality, human-follow-up recommendation,
volunteered contact details only), route to Operator Desk, and record
provider duration/cost in the usage ledger. Duplicate webhooks are idempotent.

## White-label

Each entitled org configures display name, welcome message, accent color,
support contact, and languages via org audio settings; agents, knowledge,
conversations, budgets, and retention are all tenant-isolated. A partner org
never receives Street Banker root knowledge, other orgs' conversations,
voices, or leads — the same org-scoped repositories serve every tenant.
