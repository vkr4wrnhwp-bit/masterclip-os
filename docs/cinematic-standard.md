# The locked cinematic standard

This is the default visual standard for every project. It is not decoration: the
negative constraints below are appended to every compiled prompt while
`styleBible.enforce_cinematic_standard` holds, and the craft language is a
prompt segment the compiler drops only under length pressure, and only after
everything optional has already gone.

Implemented in `packages/shot-schema/src/bible.ts` and applied by
`packages/prompt-compiler`.

---

## Realism

Every output targets cinematic realism and physically grounded photography.

Rejected by default:

obvious AI-rendered appearance · plastic skin · wax-like faces · material
blending · floating accessories · rubber movement · warped anatomy · merged
fingers · duplicate limbs · morphing props · disappearing wardrobe pieces ·
texture crawling · background smearing · inconsistent reflections · fake depth of
field · impossible camera motion · weightless movement

## Lighting

One **dominant motivated** source — neon, practical, architectural, or
environmental. Natural falloff, realistic exposure, true shadow depth,
environmental bounce, correct subject-to-background interaction.

Rejected: flat global illumination · unmotivated rim lights · excessive fill ·
artificial glow · fake volumetric haze · HDR appearance · crushed blacks with no
information.

The Shot Builder warns when `lighting.dominant_source` is empty, because a shot
with no named source drifts toward flat global illumination every time.

## Camera

Full-frame cinema-camera language:

- 35mm or 50mm for most shots; 85mm only where compression or portrait isolation
  is intentional
- f/1.8–f/2.8, real optical depth of field, natural bokeh, plausible focus
  breathing
- physically possible movement: dolly, handheld, crane, tracking, vehicle mount

Avoid generic floating-drone movement unless specifically requested. The Shot
Builder warns when `camera_position` is empty.

## Materials

Materials stay physically separate and correct:

- **skin** — pores, tonal variation, subsurface behaviour
- **fabric** — weave, weight, seams, folds, friction
- **leather and latex** — correct specular response, creasing
- **metal** — imperfect reflections, wear
- **glass** — refraction, environment-dependent reflections
- **hair** — individual strand behaviour, natural movement

## Imperfection

Synthetic perfection is the tell. Break it with controlled realism:
micro-asymmetry in faces · natural eye differences · uneven posture · real
spacing · imperfect reflections · subtle fabric variation · physically grounded
environmental wear.

## Prohibited default treatments

Never added unless a shot asks for them by name:

graphic overlays · fake film grain · fake lens dirt · haze · HDR · stylized
colour grading · over-sharpening · artificial bloom · unmotivated smoke · generic
cyberpunk lighting · empty staged posing

## Every shot must have

A clear subject · a real environment · a readable lighting source · physical
depth · narrative tension · environmental interaction · **a reason for the camera
to be where it is**.

That last one is the hardest and the most load-bearing. If you cannot say why the
camera is in that position, the shot is not designed yet — the Shot Designer
agent is instructed to refuse on exactly that basis.

---

## How this is enforced, mechanically

| Where | What happens |
|---|---|
| `defaultStyleBible()` | seeds every new project with the 24 negative constraints and 11 prohibited treatments |
| `compilePrompt()` | merges them into the negative prompt, or folds them into the positive prompt for models with no negative field |
| assembly order | subject → environment → action → performance → camera → lens → light → materials → interaction → continuity → constraints, because models weight early tokens most |
| compression | house style is dropped **first** — it is preference; identity, wardrobe, props and the locked environment are facts and are never dropped |
| Shot Builder | warns on a missing dominant light source, a missing camera position, and a duration long enough that current models degrade |
| QC prompt | the vision model is given the shot's lighting, camera, lens, and locks and asked to judge against them specifically |

A project can override any of it — `styleBible` is editable per project and
`enforce_cinematic_standard` can be switched off. The default is opinionated on
purpose.
