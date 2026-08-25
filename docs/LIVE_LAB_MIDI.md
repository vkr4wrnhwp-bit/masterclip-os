# Live Lab MIDI

`@masterclip/midi-engine` is deliberately controller-agnostic: Live Lab ships
**no per-controller profiles**. Whatever a device sends is mapped through MIDI
Learn, so any pad grid, keyboard, or fader box works on day one. Controller
presets can layer on top later without changing the model.

## Message support

`parseMidiMessage` handles Note On, Note Off (including note-on-velocity-0),
Control Change, Program Change, and Pitch Bend (normalized to 0–127). System
messages are ignored. Middle C is C4 = 60 (`noteName`).

## MIDI Learn

State machine in `learn.ts`:

1. User clicks a Live Lab control → `learn.start(target)` → UI shows
   **Waiting for MIDI input…**
2. User touches a hardware control → the first meaningful message becomes a
   `MappingCandidate` (note-off is ignored so releasing the pad that started
   the learn does not become the mapping).
3. The caller persists it → UI confirms **Mapped.**

Duplicate detection (`findDuplicate`, and server-side in the mappings route):
a candidate colliding with an existing mapping on (device, channel, type,
note/controller) returns HTTP 409 with the existing mapping's id; the UI asks
before overwriting (`replaceDuplicate: true`).

## Mapping model

```
MidiMapping {
  id, organizationId, liveProjectId,
  deviceIdentifier   // '*' matches any device
  channel            // 0–15
  messageType        // note_on | note_off | cc | program_change | pitch_bend
  noteOrController
  targetType         // pad | scene | stem_mute | stem_solo | stem_volume |
                     // master_volume | next_song | prev_song | stop | click | cue | macro
  targetId           // pad:<index>, scene id, stem id, or null
  minimum, maximum, inversion
}
```

`matchMappings` applies stored mappings to incoming messages; values scale into
`[minimum, maximum]` with optional inversion (`scaleValue`). A `note_on`
mapping also sees the matching release edge (`pressed: false`), so momentary
behaviors are possible per target. Mappings are org-scoped rows
(`live_midi_mappings`) and persist across sessions and packages.

## Device sources

- `WebMidiSource` — Web MIDI API behind its permission prompt. Connect and
  disconnect are surfaced as device-change events; an unplugged controller
  degrades to a "MIDI disconnected" indicator, never an exception in the audio
  path.
- `MockMidiSource` — programmable device for tests and the demo. The MIDI
  settings screen offers an on-screen mock controller that emits real MIDI
  bytes, so mappings are testable with no hardware. The seeded demo set maps
  mock-controller notes 36–51 to the 16 pads and CC7 to master volume.

## Keyboard zones

Default performance layout (data, not hardware profiles — any key can be
learned onto any target):

```
C2–B2 (36–47)  FX / one-shots
C3–B3 (48–59)  loops
C4–B4 (60–71)  vocal chops
C5–B5 (72–83)  scene launches
```

### Applying a zone

`POST /api/live-lab/projects/:id/midi-mappings/bulk` maps a run of consecutive
notes onto a list of targets in one call — a song's scenes in performance
order, or the sixteen pads. The MIDI screen exposes it as **Keyboard zones**:
choose device, channel, starting key and what to map, and the note→target list
is shown before anything is written.

Zones were data and documentation before this: mapping a scene-launch octave
meant twelve separate MIDI Learns. Learn is still there for one-off controls
and remains the only way to map faders, CCs and pitch bend.

Two refusals are deliberate:

- **Targets are validated up front.** If any scene in the list belongs to
  another project, nothing is written — a keyboard half-mapped because the
  eighth target was wrong is worse than a refusal.
- **Occupied keys are reported, not silently overwritten.** A run that collides
  with existing mappings returns 409 with the note numbers; `replaceExisting`
  performs the overwrite once the user has seen what they are replacing.

A chromatic sampler mode (pitching one owned/generated sample across the
keyboard) is planned for the desktop phase and intentionally not built in V1.
