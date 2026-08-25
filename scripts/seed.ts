/**
 * Seeds a demonstration project.
 *
 * Everything it creates is real: a real org and user, real shot versions
 * validated against the canonical schema, real character and world bible
 * entries. No render is submitted — `masterclip render submit` or the Shot
 * Builder does that, against the mock provider by default.
 */
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { seedAudioDemo } from '@masterclip/audio-engine'
import { seedSongLabDemo } from '@masterclip/song-lab-engine'
import { applyEnvFile, sha256Hex } from '@masterclip/shared'
import { CharacterRecord, EnvironmentRecord, emptyShot } from '@masterclip/shot-schema'
import { objectKey } from '@masterclip/asset-storage'
import { synthesizeWav, durationMsOf } from '@masterclip/ai-audio'
import { FLAGSHIP_CAPABILITIES, defaultPadMap, type PadAssignment } from '@masterclip/performance-project'

// Before the reads below, not inside main(): SEED_EMAIL and SEED_PASSWORD are
// captured at module load.
applyEnvFile()

const DEV_PASSWORD = 'masterclip-dev-password'
const EMAIL = process.env.SEED_EMAIL ?? 'producer@masterclip.local'
const PASSWORD = process.env.SEED_PASSWORD || DEV_PASSWORD

// A deployed seed writes to a log stream that is retained and readable by
// anyone with access to the host's dashboard, so the password is echoed only
// when it is the published development one and therefore not a secret at all.
const passwordIsPublic = PASSWORD === DEV_PASSWORD
const credentials = passwordIsPublic ? `${EMAIL} / ${PASSWORD}` : `${EMAIL} (password: SEED_PASSWORD)`

async function main(): Promise<void> {
  const runtime = await createRuntime()

  const existingUser = await runtime.db.get<{ id: string; org_id: string }>('SELECT id, org_id FROM users WHERE email = ?', [EMAIL])
  let orgId: string
  let userId: string

  if (existingUser) {
    orgId = String(existingUser.org_id)
    userId = String(existingUser.id)
    console.log(`reusing existing account ${EMAIL}`)
  } else {
    // The owner account this creates can spend money and read every project in
    // the org. Reaching a public URL with the password that ships in this file is
    // the same as having no password, so refuse rather than create a known
    // account. The check lives here, not at the top of main(): this seed runs on
    // every container boot, and once the owner exists the password is never used
    // again — refusing to boot over an unused variable would turn a healthy,
    // already-seeded deployment into a crash loop.
    if (process.env.NODE_ENV === 'production' && passwordIsPublic) {
      console.error('refusing to create the owner account: set SEED_PASSWORD — the development default is public')
      await runtime.close()
      process.exit(1)
    }
    const org = await runtime.projects.createOrg('Summit Arts')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Seed Producer',
      orgRole: 'owner',
    })
    orgId = org.id
    userId = user.id
    console.log(`created org ${org.id} and user ${credentials}`)
  }

  // Seeding establishes initial state; it does not append to it. A deployed
  // container runs this on every boot — every deploy, every restart, every wake
  // from idle — and without this guard each one would leave behind another
  // identical demo project. Set SEED_FORCE_PROJECT=1 to add a fresh one anyway.
  // Entitlements are idempotent and apply to already-seeded orgs too, so an
  // existing deployment picks up Live Lab on its next boot.
  await runtime.entitlements.grantAll(orgId, FLAGSHIP_CAPABILITIES)

  if (existingUser && process.env.SEED_FORCE_PROJECT !== '1') {
    const existingProjects = await runtime.projects.list(orgId)
    if (existingProjects.length > 0) {
      await seedLiveLab(runtime, orgId, userId)
      await seedSongLab(runtime, orgId, userId)
      console.log(`org already seeded (${existingProjects.length} project(s)) — nothing to do`)
      console.log(`sign in as ${EMAIL}`)
      await runtime.close()
      return
    }
  }

  const project = await runtime.projects.create({
    orgId,
    name: `Neon Rain ${new Date().toISOString().slice(11, 19)}`,
    brief:
      'A late-night performance piece. One artist, one street, one neon sign. The camera is a witness, never a participant. Rain is the only weather; the sign is the only motivated light.',
    createdBy: userId,
  })
  await runtime.cost.budgetStore.ensureDefaults('project', project.id)
  console.log(`created project ${project.id} (${project.name})`)

  await runtime.bibles.createCharacter({
    projectId: project.id,
    createdBy: userId,
    record: CharacterRecord.parse({
      character_key: 'NOVA',
      name: 'Nova',
      // Deliberately left `unverified`: identity-locked rendering is refused
      // until a person records ownership and consent for real references.
      rights_status: 'unverified',
      consent_notes: 'demonstration character — no real likeness, no references attached',
      hair: 'wet dark bob, parted left',
      skin_tone: 'warm mid brown',
      makeup: 'minimal, high-shine lip',
      wardrobe: ['black leather jacket, cracked at the left elbow', 'charcoal slip dress'],
      accessories: ['single thin gold chain'],
      hands: 'short unpainted nails, silver ring on the right index finger',
      performance_behavior: 'still until the beat lands, then decisive; never fidgets',
      prohibited_expressions: ['broad smile'],
      prohibited_wardrobe_changes: ['no hat', 'jacket stays on'],
    }),
  })

  await runtime.bibles.createEnvironment({
    projectId: project.id,
    createdBy: userId,
    record: EnvironmentRecord.parse({
      environment_key: 'ALLEY',
      name: 'Rain alley, behind the venue',
      architectural_plan: 'narrow brick service alley, fire escape camera right, loading door camera left',
      primary_materials: ['wet brick', 'standing water on broken asphalt', 'painted steel door'],
      lighting_sources: ['magenta neon sign above the loading door', 'sodium spill from the street mouth'],
      time_of_day: '01:40, after rain',
      color_temperature: 'magenta key against sodium ambience',
      spatial_relationships: 'sign is 2.5m up camera left; street mouth is 12m behind the subject',
      reflections: 'full sign reflection in standing water, broken by footfalls',
      ground_plane: 'uneven asphalt, 2cm standing water in the low centre',
      atmosphere: 'no fog; only real rain haze near the sign',
      prohibited_changes: ['no added smoke', 'no additional light sources'],
    }),
  })

  const shots = [
    {
      shot_id: 'S01',
      title: 'Sign reflection, feet enter',
      shot_category: 'insert_detail' as const,
      narrative_purpose: 'Establish the place and the only light source before we see anyone.',
      action: 'Rain rings spread across the reflection of the neon sign; a pair of boots steps into frame and breaks it.',
      camera_position: 'low, 20cm above the water, looking straight down at the reflection',
      camera_movement: 'locked off',
      lens_mm: 35,
      aperture: 2.0,
      focus_behavior: 'focus holds on the water surface throughout',
      duration_seconds: 5,
      routing_profile: 'DRAFT_MOTION' as const,
      lighting: {
        dominant_source: 'magenta neon sign, reflected',
        source_position: 'above and behind camera left',
        color_temperature: 'magenta key, sodium edge',
        falloff: 'fast falloff into black at frame edges',
        shadow_behavior: 'no cast shadows; only the reflection reads',
        practicals: [],
      },
    },
    {
      shot_id: 'S02',
      title: 'Nova under the sign',
      shot_category: 'performance' as const,
      narrative_purpose: 'Meet her. The sign does all the work.',
      action: 'She stands still, then turns her head toward the street mouth as a car passes out of frame.',
      performance_direction: 'Stillness first. The turn is decisive, not curious.',
      blocking: 'centre frame, 1.5m from the brick wall, sign above and camera left',
      camera_position: 'medium, chest height, slightly below eye line',
      camera_movement: 'slow dolly in, 30cm over the shot',
      lens_mm: 50,
      aperture: 1.8,
      focus_behavior: 'focus holds on her eyes through the dolly',
      duration_seconds: 8,
      routing_profile: 'BALANCED' as const,
      lighting: {
        dominant_source: 'magenta neon sign, camera left and above',
        source_position: 'high camera left, 45 degrees',
        color_temperature: 'magenta key against cool sodium ambience',
        falloff: 'rapid falloff to the right side of her face',
        shadow_behavior: 'hard-edged shadow under the jaw, filling from the wet ground bounce',
        practicals: [{ fixture: 'neon sign', position: 'above the loading door', color: 'magenta', intensity: 'dominant' }],
      },
      environmental_motion: ['light rain', 'ripples in standing water'],
      material_requirements: [
        { material: 'wet leather jacket', behavior: 'specular highlights break along the creases; water beads rather than soaks' },
        { material: 'wet skin', behavior: 'subsurface warmth stays visible under the magenta key' },
      ],
      screen_direction: 'left_to_right' as const,
    },
    {
      shot_id: 'S03',
      title: 'Wide, alley and street mouth',
      shot_category: 'environment' as const,
      narrative_purpose: 'Give the space scale and put her back in the world.',
      action: 'She walks away from camera toward the street mouth; the sign holds frame left.',
      camera_position: 'wide, eye level, alley centre',
      camera_movement: 'handheld, minimal drift',
      lens_mm: 35,
      aperture: 2.8,
      duration_seconds: 8,
      routing_profile: 'DRAFT_MOTION' as const,
      continuity_from_shot: 'S02',
      screen_direction: 'away_from_camera' as const,
      lighting: {
        dominant_source: 'magenta neon sign, frame left',
        source_position: 'frame left, 2.5m up',
        color_temperature: 'magenta near, sodium far',
        falloff: 'she loses the key as she walks toward the street',
        shadow_behavior: 'long reflection trailing behind her in the water',
        practicals: [{ fixture: 'neon sign', position: 'frame left', color: 'magenta', intensity: 'dominant' }],
      },
    },
  ]

  for (const partial of shots) {
    const spec = emptyShot({
      ...partial,
      project_id: project.id,
      generation_mode: 'text_to_video',
      target_resolution: '720p',
      aspect_ratio: '16:9',
      candidate_count: 4,
      max_cost_usd: 1.5,
      environment_lock: { environment_key: 'ALLEY', environment_version: 0, strength: 'strict' },
      subjects: partial.shot_id === 'S01' ? [] : [{ character_key: 'NOVA', description: 'Nova', role: 'primary' }],
    })
    const created = await runtime.projects.createShot({ projectId: project.id, spec, createdBy: userId, note: 'seeded' })
    console.log(`  shot ${created.shot.shotKey} → ${created.shot.id}`)
  }

  // Street Banker Audio Intelligence demo data: fictional meetings, briefs,
  // agent conversations, a release pack, a remix project and a verified
  // fictional voice — all rendered by the mock provider, no credentials used.
  const audioSeed = await seedAudioDemo(runtime.audio, { orgId, userId })
  console.log(audioSeed.seeded ? 'audio intelligence demo data seeded' : 'audio intelligence demo data already present')
  await seedLiveLab(runtime, orgId, userId)
  await seedSongLab(runtime, orgId, userId)

  console.log('')
  console.log(`sign in as ${credentials}`)
  console.log(`project id: ${project.id}`)
  console.log('next: pnpm masterclip render submit --shot <shotId> --count 4   (mock provider, no spend)')

  await runtime.close()
}

/**
 * The Song Lab demo: the fictional "Example Artist — Signal Fire", analysed,
 * benchmarked against a published cohort, with three experiments ready to hear.
 * The audio is synthesized locally — no real recording is involved anywhere in
 * this seed.
 */
async function seedSongLab(runtime: Runtime, orgId: string, userId: string): Promise<void> {
  const result = await seedSongLabDemo(runtime.songLab, { orgId, userId, entitlements: runtime.entitlements })
  console.log(result.seeded ? `song lab demo seeded (Example Artist — Signal Fire): ${result.projectId}` : 'song lab demo already present')
}

/**
 * The Live Lab demo: a fictional "Example Artist" set with synthesized stems
 * and scene clips. Every audio file is generated locally — no copyrighted
 * material, and the whole show (pads, scenes, stems, click, MIDI mapping,
 * offline package) is exercisable immediately after `pnpm seed`.
 */
async function seedLiveLab(runtime: Runtime, orgId: string, userId: string): Promise<void> {
  const existing = await runtime.liveLab.listProjects(orgId)
  if (existing.length > 0 && process.env.SEED_FORCE_PROJECT !== '1') {
    console.log(`live lab already seeded (${existing.length} set(s))`)
    return
  }

  const live = await runtime.liveLab.createProject({
    orgId,
    name: 'Example Artist — Demo Set',
    description: 'Fictional demo show seeded with locally synthesized audio. No real recordings.',
    artistId: 'Example Artist',
    masterTempo: 112,
    createdBy: userId,
  })
  await runtime.liveLab.ensureDefaultOutputs(orgId, live.id)

  const makeAsset = async (
    name: string,
    kind: 'audio' | 'stem' | 'click',
    spec: { bars: number; bpm: number; energy: number; layers: Record<string, boolean>; seed: number },
  ) => {
    const wav = synthesizeWav({
      bpm: spec.bpm,
      bars: spec.bars,
      energy: spec.energy,
      layers: spec.layers,
      seed: spec.seed,
    })
    const filename = `${name}.wav`
    const key = objectKey({ projectId: live.id, kind: `live-${kind}`, id: `seed-${spec.seed}`, filename })
    const digest = sha256Hex(wav)
    await runtime.storage.putBuffer(key, wav, { contentType: 'audio/wav', sha256: digest })
    return runtime.liveLab.createAsset({
      orgId,
      liveProjectId: live.id,
      kind,
      storageKey: key,
      filename,
      mime: 'audio/wav',
      bytes: wav.length,
      sha256: digest,
      durationMs: durationMsOf({ bpm: spec.bpm, bars: spec.bars }),
      metadata: { seeded: true },
      rightsOwner: 'Example Artist',
      rightsConfirmed: true,
      rightsConfirmedBy: userId,
      createdBy: userId,
    })
  }

  const SET: Array<{ title: string; type: 'song' | 'interlude' | 'walk_on' | 'encore' | 'outro'; bpm: number }> = [
    { title: 'WALK ON', type: 'walk_on', bpm: 112 },
    { title: 'TRACK ONE', type: 'song', bpm: 112 },
    { title: 'TRACK TWO', type: 'song', bpm: 124 },
    { title: 'INTERLUDE', type: 'interlude', bpm: 112 },
    { title: 'TRACK THREE', type: 'song', bpm: 98 },
    { title: 'ENCORE', type: 'encore', bpm: 128 },
    { title: 'OUTRO', type: 'outro', bpm: 112 },
  ]

  let seedCounter = 1000
  const sceneIdsByTitle = new Map<string, string>()
  const stemIdsByName = new Map<string, string>()

  for (const [index, entry] of SET.entries()) {
    const item = await runtime.liveLab.createItem({
      orgId,
      liveProjectId: live.id,
      type: entry.type,
      title: entry.title,
      sortOrder: index,
      bpm: entry.bpm,
      key: 'A minor',
      durationMs: durationMsOf({ bpm: entry.bpm, bars: 16 }),
      notes: entry.type === 'song' ? '' : `${entry.type.replace('_', ' ')} — seeded demo`,
    })

    // Scenes: songs get INTRO/VERSE/HOOK/BUILD/DROP; other items one scene.
    const sceneSpecs =
      entry.type === 'song'
        ? [
            { name: 'INTRO', sceneType: 'intro', bars: 8, energy: 0.2, layers: { pad: true, kick: true } },
            { name: 'VERSE', sceneType: 'verse', bars: 8, energy: 0.5, layers: { pad: true, kick: true, hat: true, bass: true } },
            { name: 'HOOK', sceneType: 'chorus', bars: 8, energy: 0.85, layers: { pad: true, kick: true, hat: true, bass: true } },
            { name: 'BUILD', sceneType: 'build', bars: 4, energy: 0.7, layers: { pad: true, kick: true, hat: true, riser: true } },
            { name: 'DROP', sceneType: 'drop', bars: 8, energy: 1, layers: { kick: true, hat: true, bass: true } },
          ]
        : [{ name: entry.title, sceneType: entry.type === 'walk_on' ? 'intro' : entry.type === 'outro' ? 'outro' : 'interlude', bars: 8, energy: 0.3, layers: { pad: true, bass: entry.type !== 'walk_on', kick: entry.type === 'encore' } }]

    for (const [sceneIndex, spec] of sceneSpecs.entries()) {
      const asset = await makeAsset(`${entry.title.toLowerCase().replace(/\s+/g, '-')}-${spec.name.toLowerCase()}`, 'audio', {
        bars: spec.bars,
        bpm: entry.bpm,
        energy: spec.energy,
        layers: spec.layers,
        seed: seedCounter++,
      })
      const scene = await runtime.liveLab.createScene({
        orgId,
        liveProjectId: live.id,
        liveSetItemId: item.id,
        name: spec.name,
        sceneType: spec.sceneType as never,
        sortOrder: sceneIndex,
        bars: spec.bars,
        quantization: '1bar',
        loopEnabled: spec.name === 'VERSE' || spec.name === 'HOOK',
        followAction: spec.name === 'BUILD' ? 'next_scene' : 'stop',
      })
      await runtime.liveLab.createClip({
        orgId,
        liveProjectId: live.id,
        liveSceneId: scene.id,
        name: `${entry.title} ${spec.name}`,
        sourceAssetId: asset.id,
      })
      sceneIdsByTitle.set(`${entry.title}/${spec.name}`, scene.id)
    }

    // Stems for songs: VOCAL DRUMS BASS MUSIC + CLICK.
    if (entry.type === 'song') {
      const stemSpecs = [
        { stemType: 'vocal', layers: { pad: true }, energy: 0.5 },
        { stemType: 'drums', layers: { kick: true, hat: true }, energy: 0.8 },
        { stemType: 'bass', layers: { bass: true }, energy: 0.6 },
        { stemType: 'music', layers: { pad: true }, energy: 0.7 },
        { stemType: 'click', layers: { click: true }, energy: 0.5 },
      ] as const
      for (const stemSpec of stemSpecs) {
        const asset = await makeAsset(
          `${entry.title.toLowerCase().replace(/\s+/g, '-')}-${stemSpec.stemType}`,
          stemSpec.stemType === 'click' ? 'click' : 'stem',
          { bars: 16, bpm: entry.bpm, energy: stemSpec.energy, layers: { ...stemSpec.layers }, seed: seedCounter++ },
        )
        const stem = await runtime.liveLab.createStem({
          orgId,
          liveProjectId: live.id,
          liveSetItemId: item.id,
          stemType: stemSpec.stemType,
          sourceAssetId: asset.id,
          outputId: stemSpec.stemType === 'click' ? 'click' : null,
        })
        stemIdsByName.set(`${entry.title}/${stemSpec.stemType}`, stem.id)
      }
    }
  }

  // 16-pad map, laid out like the product spec:
  //   INTRO VERSE HOOK OUTRO / DRUMS BASS VOCAL MUSIC / BUILD DROP FX1 FX2 / S1 S2 S3 STOP
  const padMap: PadAssignment[] = defaultPadMap()
  const pad = (index: number, mode: PadAssignment['mode'], label: string, targetId: string | null) => {
    padMap[index] = { index, mode, label, targetId, color: '' }
  }
  pad(0, 'scene', 'INTRO', sceneIdsByTitle.get('TRACK ONE/INTRO') ?? null)
  pad(1, 'scene', 'VERSE', sceneIdsByTitle.get('TRACK ONE/VERSE') ?? null)
  pad(2, 'scene', 'HOOK', sceneIdsByTitle.get('TRACK ONE/HOOK') ?? null)
  pad(3, 'scene', 'OUTRO', sceneIdsByTitle.get('OUTRO/OUTRO') ?? null)
  pad(4, 'stem_mute', 'DRUMS', stemIdsByName.get('TRACK ONE/drums') ?? null)
  pad(5, 'stem_mute', 'BASS', stemIdsByName.get('TRACK ONE/bass') ?? null)
  pad(6, 'stem_mute', 'VOCAL', stemIdsByName.get('TRACK ONE/vocal') ?? null)
  pad(7, 'stem_mute', 'MUSIC', stemIdsByName.get('TRACK ONE/music') ?? null)
  pad(8, 'scene', 'BUILD', sceneIdsByTitle.get('TRACK ONE/BUILD') ?? null)
  pad(9, 'scene', 'DROP', sceneIdsByTitle.get('TRACK ONE/DROP') ?? null)
  pad(10, 'scene', 'FX 1', sceneIdsByTitle.get('INTERLUDE/INTERLUDE') ?? null)
  pad(11, 'scene', 'FX 2', sceneIdsByTitle.get('WALK ON/WALK ON') ?? null)
  pad(12, 'scene', 'SCENE 1', sceneIdsByTitle.get('TRACK TWO/INTRO') ?? null)
  pad(13, 'scene', 'SCENE 2', sceneIdsByTitle.get('TRACK TWO/HOOK') ?? null)
  pad(14, 'scene', 'SCENE 3', sceneIdsByTitle.get('TRACK THREE/HOOK') ?? null)
  pad(15, 'stop', 'STOP', null)
  await runtime.liveLab.updateProject(live.id, { padMap })

  // Mock controller mapping: bottom two octaves of pads → the 16 pads, CC7 → master.
  for (let index = 0; index < 16; index++) {
    await runtime.liveLab.createMapping({
      organizationId: orgId,
      liveProjectId: live.id,
      deviceIdentifier: 'mock-controller',
      channel: 0,
      messageType: 'note_on',
      noteOrController: 36 + index,
      targetType: 'pad',
      targetId: `pad:${index}`,
      minimum: 0,
      maximum: 127,
      inversion: false,
    })
  }
  await runtime.liveLab.createMapping({
    organizationId: orgId,
    liveProjectId: live.id,
    deviceIdentifier: 'mock-controller',
    channel: 0,
    messageType: 'cc',
    noteOrController: 7,
    targetType: 'master_volume',
    targetId: null,
    minimum: 0,
    maximum: 127,
    inversion: false,
  })

  console.log(`created live lab demo set ${live.id} (Example Artist — Demo Set)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
