/**
 * Consent and disclosure primitives.
 *
 * A consent record is evidence, so it stores what was shown (the exact
 * disclosure text and its version), who acknowledged it, when, and for what.
 * The platform never draws legal conclusions about recording-consent law —
 * organizations configure jurisdiction-specific language reviewed by their own
 * counsel, and the record proves what was displayed and accepted.
 */

export type ConsentType =
  | 'recording'
  | 'upload_authorization'
  | 'agent_disclosure'
  | 'rights_confirmation'
  | 'remix_no_imitation'
  | 'voice_cloning'
  | 'dubbing_authorization'

export interface DisclosureTemplate {
  type: ConsentType
  version: string
  text: string
}

/**
 * Default disclosure texts. Organizations may replace these per jurisdiction;
 * the version string travels with every consent record either way.
 */
export const DEFAULT_DISCLOSURES: DisclosureTemplate[] = [
  {
    type: 'recording',
    version: 'v1',
    text:
      'This meeting may be recorded and transcribed for Street Banker Operator Desk records. ' +
      'By continuing you confirm every participant has been informed and any consent required in ' +
      'your jurisdiction has been obtained. Your organization is responsible for reviewing this ' +
      'language with qualified counsel.',
  },
  {
    type: 'upload_authorization',
    version: 'v1',
    text:
      'I confirm I am authorized to upload this recording and that any consent required from its ' +
      'participants has been obtained.',
  },
  {
    type: 'agent_disclosure',
    version: 'v1',
    text:
      'You are speaking with an AI-powered Street Banker assistant. This conversation may be recorded ' +
      'and transcribed if enabled. You can ask for a human operator at any time. The assistant cannot ' +
      'provide legal advice, approve deals, or make commitments on Street Banker’s behalf.',
  },
  {
    type: 'rights_confirmation',
    version: 'v1',
    text:
      'I confirm that I own or control the audio I am uploading, or have authorization from the rights ' +
      'holder to use it.',
  },
  {
    type: 'remix_no_imitation',
    version: 'v1',
    text:
      'I understand that Remix Lab will not imitate another artist’s name, voice, likeness, protected ' +
      'style, lyrics, song, album, label, or recording.',
  },
  {
    type: 'voice_cloning',
    version: 'v1',
    text:
      'I am the owner of this voice. I have completed the provider’s voice verification, and I grant the ' +
      'permissions recorded in this profile’s permission scope. I can revoke this consent at any time.',
  },
  {
    type: 'dubbing_authorization',
    version: 'v1',
    text:
      'I confirm I hold the rights to localize this content, including the underlying music, speech, and ' +
      'likenesses it contains, for the selected territories.',
  },
]

export function defaultDisclosure(type: ConsentType): DisclosureTemplate {
  const found = DEFAULT_DISCLOSURES.find((d) => d.type === type)
  if (!found) throw new Error(`no default disclosure for consent type ${type}`)
  return found
}
