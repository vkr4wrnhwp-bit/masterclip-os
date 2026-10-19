import type { WhyNote } from './components/Why.jsx'

/**
 * The words behind every "?" in MOTION (owner, 2026-10-18: "this question mark
 * should go everywhere"). Each note says what the thing is for, what you do
 * there and anything that is not obvious: what uses credits (every second of a
 * live render, with nothing included), what leaves the device, and what needs
 * Street Banker. Written from what each screen does today: its code, its own
 * help lines and the Learn MOTION lessons. Plain words; two to four sentences.
 *
 * tests/motion-why.test.ts renders every covered view and holds these words to
 * that: a label starting "What ", real sentences, no markup.
 */
export const WHY = {
  // --- the front door ------------------------------------------------------------
  startAudio: {
    label: 'What Upload audio does',
    text: [
      'Starts a new film from a song. Name the film, then pick the song from your Street Banker Vault or from this device, and say who owns it and that you may use it.',
      'The song uploads to this film as it is made, and the film opens on References, ready for Quick Create. Nothing is rendered and no credits are used.',
    ],
  },
  startIdea: {
    label: 'What Describe an idea does',
    text: [
      "Starts a new film from words. What you write becomes the film's brief, which the style bible and every shot's prompt start from.",
      'The film opens on its shot list. Nothing is rendered and no credits are used.',
    ],
  },
  startTemplate: {
    label: 'What Use a template does',
    text: [
      'Starts a new film from a ready-made shot-list format. The film is made first and opens on Import shots, where you get the template and bring your list in.',
      'Nothing is rendered and no credits are used.',
    ],
  },
  startPicture: {
    label: 'What Upload a picture or reference does',
    text: [
      'Adds a photo, artwork, clip or sound the film should take its look from.',
      'With a film already here it opens that film’s References tab with the file button ready; with no film yet you name one first. Nothing is rendered and no credits are used.',
    ],
  },
  stages: {
    label: 'What the six steps show',
    text: [
      'Where your newest film stands: Brief, Treatment, Storyboard, Render, Review and Export.',
      'The lit step is read from what the film really has, like a brief, scenes, shots, renders, approved takes and masters, and a step is never shown done without that proof. LET’S GO starts a film the way you last picked.',
    ],
  },

  // --- a film's tabs -------------------------------------------------------------
  references: {
    label: 'What References is for',
    text: [
      'The files this film may use: pictures, video and audio, up to 512 MB each, stored with this film on the MOTION server.',
      'Before you upload, type who owns the material and tick the box only if they agreed to identity work; that record is saved with the file. Only files marked that way can lock a person’s likeness.',
    ],
  },
  referencesList: {
    label: 'What this list of references shows',
    text: [
      'Everything uploaded to this film. Cleared means its owner agreed to identity work; unverified means it can guide the look but never lock a likeness.',
    ],
  },
  quickCreate: {
    label: 'What Quick Create is for',
    text: [
      'Turns a cleared song into a first shot draft: pick the recording, trim the song moment on the waveform and beat grid, write the direction, look and format, and add timed captions if you want.',
      'Save keeps a versioned draft. It does not make video, mix audio or spend credits; Shot Builder takes it from there.',
    ],
  },
  treatments: {
    label: 'What Saved creative treatments are for',
    text: [
      'Saves a direction, a look and a video format under a name, so you can reuse them on this film, up to 24.',
      'Saving changes no footage or recording and makes no video.',
    ],
  },
  variations: {
    label: 'What Creative variations are for',
    text: [
      'Saves your current direction as a new shot linked to one of your music drafts, so two ideas can be compared.',
      'No video service is called and no credits are used; the new shot renders only when you send it from Shot Builder.',
    ],
  },
  shots: {
    label: 'What the shot list is for',
    text: [
      'Every shot in this film, with its mode, routing profile, length and format. New shot opens a blank shot in Shot Builder, Build edits one and Review opens its takes.',
      'Building and reviewing are free. Credits are used only when a live render is sent, for every second of video.',
    ],
  },
  timeline: {
    label: 'What the Music Video Timeline is for',
    text: [
      'Cut up to 16 approved master clips against a cleared song, up to 60 seconds, without changing the originals.',
      'Scene planning and the first-cut suggestion only propose; nothing changes until you apply them. Saving a cut and assembling the MP4 use no render credits.',
    ],
  },
  finishVideo: {
    label: 'What Finish a real video does',
    text: [
      'Builds one straight-cut MP4 on the MOTION server from your saved cut: the approved clips and the original song.',
      'Shapes are kept with padding, nothing is cropped or posted anywhere, and no render credits are used. The video is ready only when the status says completed.',
    ],
  },
  compare: {
    label: 'What Compare variants is for',
    text: [
      'Plays real renders of a shot and its saved alternative side by side, with Play both, Pause both and Restart both.',
      'It sends no render and picks no winner. Approving a take still happens in Review.',
    ],
  },
  importShots: {
    label: 'What Import shots does',
    text: [
      'Adds many shots at once from CSV or JSON that you paste in. The template link gives you the right columns.',
      'Dry run checks every row and says which would be refused and why, without saving anything; Import saves them.',
    ],
  },
  brief: {
    label: 'What the creative brief is',
    text: [
      "The words this film started from, as they were written when it was made. The style bible and every shot's prompt build on them.",
    ],
  },
  styleBible: {
    label: 'What the style bible is',
    text: [
      "The film's shared visual rules, kept as data, that every shot's prompt is built with. It is shown here to read; nothing on this tab changes it.",
    ],
  },

  // --- the project pages ---------------------------------------------------------
  queue: {
    label: 'What the render queue shows',
    text: [
      'Every render this film sent, live or sandbox, with its status, model, estimate, actual cost and tries. Retry, Cancel or View act on one job.',
      'Each live render uses Street Banker credits for every second of video, more for higher-quality models, and nothing is included. A take you throw away still counts; a render the video service fails is refunded.',
    ],
  },
  masters: {
    label: 'What Masters are',
    text: [
      'A master is a take a person approved and promoted. Render deliverable converts it to the format you pick, and Build delivery package gathers the files with a record of where they came from.',
      'Converting adds no detail: a 720p source stays 720p. Converting and packaging use no render credits.',
    ],
  },
  sendToVault: {
    label: 'What Send to my Vault does',
    text: [
      'Sends this signed-off master to your Street Banker Vault, once; after that it says Already in your Vault.',
      'The button shows only when MOTION was opened from Street Banker and the Vault is connected. Nothing goes to the Vault until you press it.',
    ],
  },
  songFinishing: {
    label: 'What Song-moment finishing does',
    text: [
      "Swaps the take's generated sound for your cleared recording over the chosen song moment, in a real MP4 made on the MOTION server.",
      'Burning captions makes a second copy with your timed lines and keeps the clean one. Neither posts anything or uses render credits.',
    ],
  },
  costLab: {
    label: 'What the Cost lab shows',
    text: [
      'What this film’s renders cost, measured per approved second of video, because a cheap take nobody keeps still costs money.',
      'The figures are what the video services charge, in dollars, as MOTION records them; sandbox runs cost nothing real. Your Street Banker credits are counted separately.',
    ],
  },
  spendByModel: {
    label: 'What Spend by model shows',
    text: [
      'The charges recorded for this film, grouped by video service and model, with how many there were and what they came to.',
      'Nothing is listed until a render has been charged.',
    ],
  },
  rejections: {
    label: 'What this list of rejections shows',
    text: [
      'Why takes were turned down, by reason and by model, counted from the checks and reviews on this film. It shows which model keeps failing a shot before you send more.',
    ],
  },
  acceptance: {
    label: 'What Model acceptance history shows',
    text: [
      'For each model and kind of shot: how many takes were sent, how many passed the technical checks and how many a person approved.',
      'Until enough takes are reviewed, the router works from careful starting guesses.',
    ],
  },
  simulator: {
    label: 'What the draft-first calculator does',
    text: [
      'Type how many approved masters you need, the drafts per master, what each costs and two approval rates, then press Compare.',
      'It shows the total each way with the assumptions it used. It renders nothing and spends nothing.',
    ],
  },
  providers: {
    label: 'What Providers and models shows',
    text: [
      'Which video services MOTION can use here, the models each offers and the rules for choosing one. Refresh catalog reads the model list again.',
      'In sandbox mode nothing is billed and renders come from a local test video maker. Live mode needs a service key and is still held back by the spending caps.',
    ],
  },
  connected: {
    label: 'What Connected providers shows',
    text: [
      'Each video service, whether its key is set (only a short fingerprint of it is shown) and its last health check.',
      'A service with no key cannot render. Keys are set on the server, never on this page.',
    ],
  },
  catalog: {
    label: 'What the Model catalog shows',
    text: [
      'Every model MOTION knows, with its tier (draft, standard or premium), what it can do and its listed price where one is known.',
      'Live quote means the price is known only when the service quotes a job.',
    ],
  },
  profiles: {
    label: 'What Routing profiles are',
    text: [
      "The rules a shot's routing profile sets: which model tiers it may use, the most it may cost per second, and whether a person must approve before it renders.",
      "The shot list shows each shot's profile, such as HERO.",
    ],
  },
} satisfies Record<string, WhyNote>

export type WhyKey = keyof typeof WHY
