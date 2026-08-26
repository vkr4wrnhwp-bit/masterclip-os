import React from 'react'
import { AsyncBlock, Badge, Callout, Card, Field, Stat, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'
import {
  AbPlayer,
  BenchmarkRow,
  ClassificationChip,
  ConfidencePill,
  EnergyBars,
  EnergyCurve,
  LowSampleWarning,
  ObservationCard,
  RegisterPanel,
  StructureTimeline,
  Tabs,
} from './components.jsx'
import {
  clock,
  seconds,
  songLabApi,
  type Measured,
  type ProducerFeatureRow,
  type SectionRegisterBand,
  type SongSection,
} from './api.js'

/**
 * The project workspace.
 *
 * Artist View by default — plain English, three things worth testing, and the
 * tabs behind it. Producer View and the internal A&R view are separate tabs
 * because burying forty raw features in front of an artist is how a diagnostic
 * tool stops being usable.
 */
export function SongLabProject({ projectId, tab, canSeeAr }: { projectId: string; tab: string; canSeeAr: boolean }) {
  const detail = useAsync(() => songLabApi.project(projectId), [projectId])

  return (
    <AsyncBlock state={detail}>
      {(data) => (
        <>
          <div className="topbar">
            <div>
              <h2>{data.project.title}</h2>
              <div className="meta">
                {data.project.artistName} · {data.project.genre.replace(/_/g, ' ')}
                {data.analysis?.durationMs ? ` · ${clock(data.analysis.durationMs)}` : ''}
                {data.project.demo && <Badge tone="info"> demo</Badge>}
              </div>
            </div>
            <div className="button-row" style={{ margin: 0 }}>
              <button className="small" onClick={() => void songLabApi.reanalyze(projectId).then(() => detail.reload())}>
                Reanalyze with current engine
              </button>
            </div>
          </div>

          <Tabs projectId={projectId} active={tab} extra={canSeeAr ? [{ key: 'ar', label: 'A&R' }] : []} />

          {data.project.status === 'analyzing' && (
            <Callout tone="info" title="Analysis running">
              This song is being analysed. Structure, energy and benchmark results appear as each stage completes.
            </Callout>
          )}
          {data.project.status === 'failed' && (
            <Callout tone="danger" title="Analysis failed">
              {data.analysis?.failureReason ?? 'The analysis could not complete. The original audio is untouched.'}
            </Callout>
          )}

          {tab === 'overview' && <OverviewTab projectId={projectId} detail={data} reload={detail.reload} />}
          {tab === 'structure' && <StructureTab projectId={projectId} />}
          {tab === 'hook' && <HookTab projectId={projectId} />}
          {tab === 'lyrics' && <LyricsTab projectId={projectId} />}
          {tab === 'energy' && <EnergyTab projectId={projectId} />}
          {tab === 'tempo' && <TempoTab projectId={projectId} />}
          {tab === 'arrangement' && <ArrangementTab projectId={projectId} />}
          {tab === 'benchmark' && <BenchmarkTab projectId={projectId} />}
          {tab === 'experiments' && <ExperimentsTab projectId={projectId} />}
          {tab === 'producer' && <ProducerTab projectId={projectId} />}
          {tab === 'versions' && <VersionsTab projectId={projectId} />}
          {tab === 'ar' && canSeeAr && <ArTab projectId={projectId} />}
        </>
      )}
    </AsyncBlock>
  )
}

// ------------------------------------------------------------- overview ----

function OverviewTab({
  projectId,
  detail,
  reload,
}: {
  projectId: string
  detail: Awaited<ReturnType<typeof songLabApi.project>>
  reload: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  const hearTest = async (recommendationId: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await songLabApi.createExperiment(projectId, { experimentType: 'custom', recommendationId, render: true })
      if (!result.experiment) setMessage(result.message ?? 'No audio experiment could be built for this note.')
      else navigate(`/song-lab/projects/${projectId}/experiments`)
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
      reload()
    }
  }

  const analysis = detail.analysis
  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Card>
          <Stat value={analysis?.durationMs ? clock(analysis.durationMs) : null} label="Runtime" />
        </Card>
        <Card>
          <Stat value={analysis?.bpm ? `${Math.round(analysis.bpm)}` : null} label="Estimated BPM" />
          <ConfidencePill confidence={analysis?.bpmConfidence ?? 0} />
        </Card>
        <Card>
          <Stat value={analysis?.key ?? null} label="Key" />
          <ConfidencePill confidence={analysis?.keyConfidence ?? 0} />
        </Card>
        <Card>
          <Stat
            value={analysis?.featureVector?.metrics.first_chorus_seconds?.value ? seconds(analysis.featureVector.metrics.first_chorus_seconds.value) : null}
            label="First chorus"
          />
        </Card>
      </div>

      <Card title="Three things worth testing">
        {message && <Callout tone="info">{message}</Callout>}
        {detail.thingsWorthTesting.length === 0 ? (
          <div className="empty">
            {detail.project.selectedBenchmarkCohortId
              ? 'Nothing in this song sits outside the middle half of the selected cohort. That is a finding, not a gap.'
              : 'Select a comparison cohort on the Benchmark tab to see how this song differs from a relevant group.'}
          </div>
        ) : (
          detail.thingsWorthTesting.map((observation, index) => (
            <ObservationCard key={observation.id} observation={observation} index={index} onTest={hearTest} busy={busy} />
          ))
        )}
      </Card>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Structure">
          <StructureTimeline sections={detail.sections} />
        </Card>
        <Card title="Listen">
          <AbPlayer tracks={[{ id: 'original', label: 'Original', url: detail.audioUrl }]} />
          <p className="faint" style={{ marginTop: 10 }}>
            The original is never modified. Every experiment renders to a separate preview and becomes a new version only if you accept it.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <VocalBasisPanel projectId={projectId} detail={detail} reload={reload} />
      </div>

      <Card title="Everything measured" action={<span className="faint">{detail.observations.length} observations</span>}>
        {detail.observations.length === 0 ? (
          <div className="empty">no observations yet</div>
        ) : (
          detail.observations.map((observation) => <ObservationCard key={observation.id} observation={observation} onTest={hearTest} busy={busy} />)
        )}
      </Card>
    </>
  )
}

/**
 * What the vocal numbers were measured from, and how to improve that.
 *
 * The figures themselves live on other tabs. What belongs here is the
 * qualifier, because a vocal-occupancy percentage taken from a full mix and one
 * taken from an isolated vocal are not the same claim, and the artist has no
 * way to tell them apart from the number alone.
 *
 * Separation is offered, never performed automatically: it spends the
 * organization's provider budget, and that is the artist's call.
 */
function VocalBasisPanel({
  projectId,
  detail,
  reload,
}: {
  projectId: string
  detail: Awaited<ReturnType<typeof songLabApi.project>>
  reload: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const stems = useAsync(() => songLabApi.vocalStems(projectId), [projectId, detail.analysis?.id])

  const versionId = detail.project.currentVersionId
  const basis = detail.analysis?.vocalAnalysis?.basis ?? 'full_mix'
  const isolated = basis === 'isolated_stem'

  const separate = async () => {
    if (!versionId) return
    setBusy(true)
    setError(null)
    try {
      await songLabApi.separateVocal(projectId, versionId)
      stems.reload()
      reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const current = stems.data?.vocalStems.find((stem) => stem.songVersionId === versionId) ?? null
  // A stem exists for this recording but the figures on screen were still
  // measured from the mix. Separation queues the re-measurement itself, so this
  // is normally the few seconds before that job lands — but it is also where a
  // project sits if that queueing failed, which is why the manual path stays.
  const awaitingRemeasure = current?.status === 'ready' && !isolated

  const remeasure = async () => {
    setBusy(true)
    setError(null)
    try {
      await songLabApi.reanalyze(projectId)
      reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Vocal measurement" action={<ClassificationChip label={isolated ? 'Isolated Vocal' : 'Full Mix'} />}>
      {error && <Callout tone="warn">{error}</Callout>}

      <p className="faint">
        {isolated
          ? 'Vocal occupancy, time to first vocal, phrase length and rest ratio were measured from a separated lead vocal.'
          : 'Vocal occupancy, time to first vocal, phrase length and rest ratio are estimated from the full mix. The detector infers where the voice is from band energy and tonality, so a dense arrangement reads as more vocal than it is. These figures carry lower confidence for that reason.'}
      </p>

      {current?.status === 'pending' && (
        <Callout tone="info">Separating the lead vocal. Re-measuring starts on its own as soon as it finishes.</Callout>
      )}
      {awaitingRemeasure && (
        <Callout tone="info">
          The lead vocal was separated{current?.stemName ? ` (${current.stemName})` : ''}. The figures above are still the
          mix-based estimate until the re-measurement finishes.
        </Callout>
      )}
      {current?.status === 'unsupported' && (
        <Callout tone="info">
          {current.provider} could not return an isolated lead vocal, so the vocal figures stay measured from the mix.
          {current.failureReason ? ` (${current.failureReason})` : ''}
        </Callout>
      )}
      {current?.status === 'failed' && <Callout tone="warn">Separation failed: {current.failureReason ?? 'unknown reason'}</Callout>}

      {awaitingRemeasure && (
        <button className="small" onClick={remeasure} disabled={busy}>
          Re-measure from the separated vocal
        </button>
      )}

      {!isolated && current?.status !== 'pending' && current?.status !== 'ready' && (
        <button className="small" onClick={separate} disabled={busy || !versionId}>
          {current ? 'Try separating the vocal again' : 'Separate the vocal and re-measure'}
        </button>
      )}
    </Card>
  )
}

// ------------------------------------------------------------ structure ----

function StructureTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.structure(projectId), [projectId])
  const [selected, setSelected] = React.useState<SongSection | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const save = async (patch: Partial<SongSection> & { deleted?: boolean }) => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      await songLabApi.correctStructure(projectId, {
        corrections: [
          {
            id: selected.id,
            ...(patch.sectionType ? { sectionType: patch.sectionType } : {}),
            ...(patch.label ? { label: patch.label } : {}),
            ...(patch.startMs !== undefined ? { startMs: patch.startMs } : {}),
            ...(patch.endMs !== undefined ? { endMs: patch.endMs } : {}),
            ...(patch.isHook !== undefined ? { isHook: patch.isHook } : {}),
            ...(patch.isTitlePhrase !== undefined ? { isTitlePhrase: patch.isTitlePhrase } : {}),
            ...(patch.deleted ? { deleted: true } : {}),
          },
        ],
      })
      setSelected(null)
      state.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <div className="grid cols-2">
          <Card title="Timeline" action={<span className="faint">click a section to correct it</span>}>
            <StructureTimeline sections={data.sections} onSelect={setSelected} selectedId={selected?.id ?? null} />
            <p className="faint" style={{ marginTop: 10 }}>
              Machine-detected boundaries are a starting point. Anything you correct is marked confirmed, becomes authoritative for this
              project, and survives reanalysis.
            </p>
          </Card>
          <Card title={selected ? `Correct ${selected.label}` : 'Structural metrics'}>
            {selected ? (
              <SectionEditor section={selected} onSave={save} onCancel={() => setSelected(null)} busy={busy} error={error} />
            ) : (
              <MetricsList metrics={data.metrics} />
            )}
          </Card>
        </div>
      )}
    </AsyncBlock>
  )
}

const SECTION_TYPES = [
  'intro', 'verse', 'pre_chorus', 'chorus', 'post_chorus', 'hook', 'bridge', 'break',
  'drop', 'instrumental', 'solo', 'breakdown', 'final_chorus', 'outro', 'custom',
]

function SectionEditor({
  section,
  onSave,
  onCancel,
  busy,
  error,
}: {
  section: SongSection
  onSave: (patch: Partial<SongSection> & { deleted?: boolean }) => void
  onCancel: () => void
  busy: boolean
  error: string | null
}) {
  const [label, setLabel] = React.useState(section.label)
  const [sectionType, setSectionType] = React.useState(section.sectionType)
  const [startSeconds, setStartSeconds] = React.useState(Math.round(section.startMs / 1000))
  const [endSeconds, setEndSeconds] = React.useState(Math.round(section.endMs / 1000))
  const [isHook, setIsHook] = React.useState(section.isHook)
  const [isTitle, setIsTitle] = React.useState(section.isTitlePhrase)

  React.useEffect(() => {
    setLabel(section.label)
    setSectionType(section.sectionType)
    setStartSeconds(Math.round(section.startMs / 1000))
    setEndSeconds(Math.round(section.endMs / 1000))
    setIsHook(section.isHook)
    setIsTitle(section.isTitlePhrase)
  }, [section.id])

  return (
    <div>
      <Field label="Label">
        <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} />
      </Field>
      <Field label="Section type">
        <select value={sectionType} onChange={(event) => setSectionType(event.target.value)}>
          {SECTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid cols-2">
        <Field label="Start (seconds)">
          <input type="number" min={0} value={startSeconds} onChange={(event) => setStartSeconds(Number(event.target.value))} />
        </Field>
        <Field label="End (seconds)">
          <input type="number" min={1} value={endSeconds} onChange={(event) => setEndSeconds(Number(event.target.value))} />
        </Field>
      </div>
      <label className="sl-inline-check">
        <input type="checkbox" checked={isHook} onChange={(event) => setIsHook(event.target.checked)} /> This is the actual hook
      </label>
      <label className="sl-inline-check">
        <input type="checkbox" checked={isTitle} onChange={(event) => setIsTitle(event.target.checked)} /> The title phrase lands here
      </label>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="button-row">
        <button
          className="primary small"
          disabled={busy}
          onClick={() => onSave({ label, sectionType, startMs: startSeconds * 1000, endMs: endSeconds * 1000, isHook, isTitlePhrase: isTitle })}
        >
          Save correction
        </button>
        <button className="small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="small" onClick={() => onSave({ deleted: true })} disabled={busy}>
          Merge into neighbour (delete)
        </button>
      </div>
    </div>
  )
}

function MetricsList({ metrics }: { metrics: Record<string, number | null> }) {
  const rows: Array<[string, string]> = [
    ['Intro', seconds(metrics.introSeconds as number | null)],
    ['Time to first vocal', seconds(metrics.firstVocalSeconds as number | null)],
    ['Time to first hook', seconds(metrics.firstHookSeconds as number | null)],
    ['Time to first chorus', seconds(metrics.firstChorusSeconds as number | null)],
    ['Verse 1', seconds(metrics.firstVerseSeconds as number | null)],
    ['Verse 2', seconds(metrics.secondVerseSeconds as number | null)],
    ['Chorus (mean)', seconds(metrics.chorusSeconds as number | null)],
    ['Outro', seconds(metrics.outroSeconds as number | null)],
    ['Choruses', String(metrics.chorusCount ?? '—')],
    ['Verses', String(metrics.verseCount ?? '—')],
    ['Sections', String(metrics.sectionCount ?? '—')],
    ['Unique sections', String(metrics.uniqueSectionCount ?? '—')],
    ['Chorus share of runtime', metrics.chorusShare === null || metrics.chorusShare === undefined ? '—' : `${Math.round(metrics.chorusShare)}%`],
    ['Runtime before first repeat', seconds(metrics.runtimeBeforeFirstRepeat as number | null)],
    ['Runtime after final hook', seconds(metrics.runtimeAfterFinalHook as number | null)],
    ['Structural symmetry', metrics.structuralSymmetry === null || metrics.structuralSymmetry === undefined ? '—' : String(metrics.structuralSymmetry)],
    ['Section-length variance', metrics.sectionLengthVariance === null || metrics.sectionLengthVariance === undefined ? '—' : String(metrics.sectionLengthVariance)],
    ['Section order', String(metrics.sectionOrderPattern ?? '—')],
  ]
  return (
    <table>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td className="faint">{label}</td>
            <td className="num">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ------------------------------------------------------------------ hook ----

function HookTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.hook(projectId), [projectId])
  const chant = useAsync(() => songLabApi.chant(projectId).catch(() => ({ opportunities: [] })), [projectId])

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Card title="Hook architecture">
            <p className="faint">
              A profile, not a score. Nine independent measurements, each with its own confidence — compressing them into one number would
              hide exactly the disagreements worth looking at.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Finding</th>
                  <th>Against cohort</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.profile.rows.map((row) => (
                  <tr key={row.metric}>
                    <td>{row.metric}</td>
                    <td className="num">{row.finding}</td>
                    <td>{row.classification}</td>
                    <td>
                      <ConfidencePill confidence={row.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Three hook experiments">
            {data.profile.experiments.length === 0 ? (
              <div className="empty">Nothing in the hook sits outside the cohort's middle half.</div>
            ) : (
              data.profile.experiments.map((experiment) => (
                <div className="sl-recommendation" key={experiment.title}>
                  <div>
                    <strong>{experiment.title}</strong>
                    <p className="faint">{experiment.description}</p>
                  </div>
                  <Badge tone={experiment.experimentSupported ? 'accent' : 'info'}>
                    {experiment.experimentSupported ? 'can be rendered' : 'writing note'}
                  </Badge>
                </div>
              ))
            )}
          </Card>

          <Card title="Chant opportunity">
            <AsyncBlock state={chant}>
              {(chantData) =>
                chantData.opportunities.length === 0 ? (
                  <div className="empty">No section measured enough rhythmic space for a crowd-response element.</div>
                ) : (
                  <>
                    {chantData.opportunities.map((opportunity) => (
                      <div className="sl-chant" key={opportunity.sectionLabel}>
                        <div className="sl-observation-head">
                          <span className="sl-timeline-time">{clock(opportunity.startMs)}</span>
                          <strong>{opportunity.sectionLabel.toUpperCase()}</strong>
                          <Badge tone="accent">{Math.round(opportunity.score * 100)}</Badge>
                        </div>
                        <p>{opportunity.observation}</p>
                        <div className="sl-patterns">
                          {opportunity.patterns.map((pattern) => (
                            <div className="sl-pattern" key={pattern.pattern}>
                              <div className="sl-pattern-rhythm">{pattern.rhythm}</div>
                              <strong>{pattern.label}</strong>
                              <p className="faint">{pattern.description}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <p className="faint">
                      Rhythmic shapes first — where the syllables would sit. Song Lab does not write the words; those are yours.
                    </p>
                  </>
                )
              }
            </AsyncBlock>
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

// ---------------------------------------------------------------- lyrics ----

function LyricsTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.lyrics(projectId), [projectId])
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  // Separate from `error`: the two actions live in different cards, and the
  // add-lyrics card is not rendered once a lyric exists.
  const [transcribeError, setTranscribeError] = React.useState<string | null>(null)
  const [confirmReplace, setConfirmReplace] = React.useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await songLabApi.setLyrics(projectId, text)
      setText('')
      state.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * `replace` is passed only from the second, explicit press. A transcript
   * silently overwriting words the artist typed is the one genuinely
   * destructive thing this screen could do.
   */
  const transcribe = async (replace = false) => {
    setBusy(true)
    setTranscribeError(null)
    setNotice(null)
    try {
      const result = await songLabApi.transcribeLyrics(projectId, replace)
      setNotice(
        result.source === 'isolated_stem'
          ? 'Transcribing the separated vocal. The lyric will appear here with timings when it finishes.'
          : 'Transcribing the full mix. Separating the vocal first (Overview) usually gives a more accurate lyric.',
      )
      state.reload()
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('already has a lyric you supplied')) setConfirmReplace(true)
      setTranscribeError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          {!data.analysis && (
            <Card title="Add lyrics">
              <p className="faint">
                Lyric analysis runs only on lyrics you supply or transcribe from audio you have confirmed you control. Musical analysis does
                not need them — this is optional.
              </p>
              <Field label="Lyric sheet" hint="paste plain lines; [Chorus] style headers are read as hints">
                <textarea rows={12} value={text} onChange={(event) => setText(event.target.value)} />
              </Field>
              {error && <Callout tone="danger">{error}</Callout>}
              {notice && <Callout tone="info">{notice}</Callout>}
              <div className="button-row">
                <button className="primary" onClick={save} disabled={busy || text.trim().length === 0}>
                  {busy ? 'analysing…' : 'Save and analyse'}
                </button>
              </div>
            </Card>
          )}

          {/*
            Outside the add-lyrics card on purpose. That card only renders while
            there is no lyric yet, and replacing an existing one is exactly the
            case that needs this control — hiding it there would make the
            replace path unreachable.
          */}
          <Card title="Transcribe from the recording">
            <p className="faint">
              A transcript arrives with timings, which is what lets syllable density and title placement be measured per section. A pasted
              sheet has no timings, so those figures stay unmeasured until someone types timecodes by hand. The words are the
              transcriber&rsquo;s guess until you confirm them.
            </p>
            {notice && <Callout tone="info">{notice}</Callout>}
            {transcribeError && !confirmReplace && <Callout tone="danger">{transcribeError}</Callout>}
            {confirmReplace && (
              <Callout tone="warn">
                This version already has a lyric you supplied. Transcribing replaces it with the transcriber&rsquo;s guess.
              </Callout>
            )}
            <div className="button-row">
              <button className="small" onClick={() => transcribe(false)} disabled={busy}>
                {busy ? 'working…' : 'Transcribe from the recording'}
              </button>
              {confirmReplace && (
                <button className="small" onClick={() => transcribe(true)} disabled={busy}>
                  Replace my lyric with a transcript
                </button>
              )}
            </div>
          </Card>

          {data.analysis && (
            <>
              <div className="grid cols-4" style={{ marginBottom: 16 }}>
                <Card>
                  <Stat value={data.analysis.totalSyllables} label="Total syllables" />
                </Card>
                <Card>
                  <Stat value={data.analysis.syllablesPerSecond ?? null} label="Syllables / second" />
                </Card>
                <Card>
                  <Stat value={data.analysis.titleRepetition} label="Title appearances" />
                </Card>
                <Card>
                  <Stat value={data.analysis.medianHookLineSyllables ?? null} label="Median hook line" />
                </Card>
              </div>

              <Card title="Syllable architecture">
                <table>
                  <thead>
                    <tr>
                      <th>Section</th>
                      <th>Lines</th>
                      <th>Syllables</th>
                      <th>Median line</th>
                      <th>Longest line</th>
                      <th>Per second</th>
                      <th>Title</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.analysis.sections.map((section) => (
                      <tr key={section.sectionOrderIndex}>
                        <td>{(section.sectionType ?? 'section').replace(/_/g, ' ')}</td>
                        <td className="num">{section.lineCount}</td>
                        <td className="num">{section.syllableCount}</td>
                        <td className="num">{section.medianLineSyllables}</td>
                        <td className="num">{section.longestLineSyllables}</td>
                        <td className="num">{section.syllablesPerSecond ?? '—'}</td>
                        <td className="num">{section.titleAppearances}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="faint">
                  Syllable counts come from a heuristic, not a pronunciation dictionary. Relative density between sections holds up; a single
                  line's exact count may be off by one.
                </p>
              </Card>

              <div className="grid cols-2">
                <Card title="Title placement">
                  {data.analysis.titlePlacement.length === 0 ? (
                    <div className="empty">
                      No title phrase detected. Mark the lines that carry the title below, or set the title phrase in project settings.
                    </div>
                  ) : (
                    <table>
                      <tbody>
                        {data.analysis.titlePlacement.map((entry) => (
                          <tr key={entry.sectionOrderIndex}>
                            <td className="faint">{(entry.sectionType ?? 'section').replace(/_/g, ' ')}</td>
                            <td className="num">{entry.count}</td>
                          </tr>
                        ))}
                        <tr>
                          <td>
                            <strong>Total</strong>
                          </td>
                          <td className="num">
                            <strong>{data.analysis.titleRepetition}</strong>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                </Card>
                <Card title="Repetition and overlap">
                  <table>
                    <tbody>
                      <tr>
                        <td className="faint">Repeated lines</td>
                        <td className="num">{data.analysis.lyricRepetition}%</td>
                      </tr>
                      <tr>
                        <td className="faint">Verse / chorus vocabulary overlap</td>
                        <td className="num">{data.analysis.verseChorusVocabularyOverlap === null ? 'not enough information' : `${data.analysis.verseChorusVocabularyOverlap}%`}</td>
                      </tr>
                      <tr>
                        <td className="faint">Chorus density</td>
                        <td className="num">{data.analysis.chorusSyllablesPerSecond ?? 'not enough information'}</td>
                      </tr>
                      <tr>
                        <td className="faint">Verse density</td>
                        <td className="num">{data.analysis.verseSyllablesPerSecond ?? 'not enough information'}</td>
                      </tr>
                      <tr>
                        <td className="faint">Rhyme groups</td>
                        <td className="num">{data.analysis.rhymeGroups.length}</td>
                      </tr>
                    </tbody>
                  </table>
                </Card>
              </div>

              <Card title="Lines" action={<span className="faint">click a line to mark it as the title phrase</span>}>
                <TitleMarker projectId={projectId} lines={data.lines} onChanged={state.reload} />
              </Card>
            </>
          )}
        </>
      )}
    </AsyncBlock>
  )
}

function TitleMarker({
  projectId,
  lines,
  onChanged,
}: {
  projectId: string
  lines: Awaited<ReturnType<typeof songLabApi.lyrics>>['lines']
  onChanged: () => void
}) {
  const [selected, setSelected] = React.useState<number[]>(lines.filter((line) => line.titlePhrase).map((line) => line.lineIndex))
  const [busy, setBusy] = React.useState(false)

  const toggle = (index: number) =>
    setSelected((current) => (current.includes(index) ? current.filter((value) => value !== index) : [...current, index]))

  return (
    <div>
      <div className="sl-lyric-lines">
        {lines.map((line) => (
          <button
            type="button"
            key={line.id}
            className={`sl-lyric-line${selected.includes(line.lineIndex) ? ' selected' : ''}`}
            onClick={() => toggle(line.lineIndex)}
          >
            <span className="sl-lyric-syllables">{line.syllableCount}</span>
            <span>{line.text}</span>
          </button>
        ))}
      </div>
      <div className="button-row">
        <button
          className="primary small"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void songLabApi
              .markTitleLines(projectId, selected)
              .then(onChanged)
              .finally(() => setBusy(false))
          }}
        >
          Confirm title lines
        </button>
        <span className="faint">A line you confirm outranks anything the detector inferred.</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- energy ----

function EnergyTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.energy(projectId), [projectId])
  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Card title="Energy curve">
            <EnergyCurve values={data.curve} stepSeconds={data.stepSeconds} />
            <p className="faint">
              A composite of loudness, spectral spread, transient activity, low-end weight and brightness — not loudness alone. Values are
              normalized within this song, so they compare sections to each other, not this song to another.
            </p>
          </Card>
          <Card title="Section energy">
            <EnergyBars sections={data.sections} />
            <p className="faint" style={{ marginTop: 12 }}>
              Higher is not better. A record that stays level throughout may be doing exactly what it intends.
            </p>
          </Card>
          <Card title="Section detail">
            <table>
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Start</th>
                  <th>Energy</th>
                  <th>Vocal occupancy</th>
                  <th>Arrangement density</th>
                </tr>
              </thead>
              <tbody>
                {data.sections.map((section) => (
                  <tr key={section.label}>
                    <td>{section.label}</td>
                    <td className="num">{clock(section.startMs)}</td>
                    <td className="num">{section.energy}</td>
                    <td className="num">{section.vocalOccupancy === null ? 'not enough information' : `${section.vocalOccupancy}%`}</td>
                    <td className="num">{section.arrangementDensity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

// ----------------------------------------------------------------- tempo ----

function TempoTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.tempo(projectId), [projectId])
  const [busy, setBusy] = React.useState(false)
  const [custom, setCustom] = React.useState('')
  const [message, setMessage] = React.useState<string | null>(null)

  const test = async (bpm: number) => {
    setBusy(true)
    setMessage(null)
    try {
      await songLabApi.createExperiment(projectId, { experimentType: 'tempo', amount: bpm, name: `${Math.round(bpm)} BPM`, render: true })
      navigate(`/song-lab/projects/${projectId}/experiments`)
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Card>
              <Stat value={data.bpm ? Math.round(data.bpm) : null} label="Current BPM" />
              <ConfidencePill confidence={data.bpmConfidence ?? 0} />
            </Card>
            <Card>
              <Stat value={data.tempoStability !== null ? data.tempoStability.toFixed(2) : null} label="Tempo stability" />
            </Card>
            <Card>
              <Stat value={data.benchmark?.cohortMedian ? Math.round(data.benchmark.cohortMedian) : null} label="Cohort median BPM" />
              {data.benchmark && <span className="faint">n = {data.benchmark.sampleSize}</span>}
            </Card>
          </div>

          {data.benchmark && (
            <Card title="Against the selected cohort">
              <BenchmarkRow result={data.benchmark} />
              <p className="faint">
                Changing the tempo moves the track within this cohort's range. Whether that improves the song is a listening decision — the
                measurement cannot make it for you.
              </p>
            </Card>
          )}

          <Card title="Hear a tempo test">
            {message && <Callout tone="danger">{message}</Callout>}
            <div className="sl-tempo-buttons">
              <button className="small" disabled>
                ORIGINAL {data.bpm ? Math.round(data.bpm) : '—'}
              </button>
              {data.suggestions.map((suggestion) => (
                <button key={suggestion.delta} className="small" disabled={busy} onClick={() => test(suggestion.bpm)}>
                  +{suggestion.delta} → {suggestion.bpm}
                </button>
              ))}
              <input
                type="number"
                placeholder="custom BPM"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                style={{ width: 120 }}
              />
              <button className="small" disabled={busy || !custom} onClick={() => test(Number(custom))}>
                Test custom
              </button>
            </div>
            <p className="faint">
              Pitch is preserved. The runtime of the result is recalculated automatically and shown before you listen. The original tempo is
              always one click away.
            </p>
            {data.bpm === null && (
              <Callout tone="warn" title="NOT ENOUGH INFORMATION">
                No stable pulse was detected in this recording, so there is no reliable tempo to change. You can still set one by hand from
                the project settings.
              </Callout>
            )}
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

// ----------------------------------------------------------- arrangement ----

function ArrangementTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.arrangement(projectId), [projectId])
  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Card title="Repeated sections">
            {data.repeats.length === 0 ? (
              <div className="empty">No section type recurs in this song, so there is nothing to compare against itself.</div>
            ) : (
              data.repeats.map((contrast) => (
                <div className="sl-contrast" key={`${contrast.fromLabel}-${contrast.toLabel}`}>
                  <div className="sl-observation-head">
                    <strong>
                      {contrast.fromLabel.toUpperCase()} → {contrast.toLabel.toUpperCase()}
                    </strong>
                    <Badge tone={contrast.similarity >= 0.88 ? 'accent' : 'info'}>Similarity {Math.round(contrast.similarity * 100)}%</Badge>
                  </div>
                  <p className="faint">
                    Energy {signed(contrast.energyDelta)} · spectral {signed(contrast.spectralDelta)} · low end {signed(contrast.lowFrequencyDelta)} ·
                    transients {signed(contrast.transientDelta)}
                    {contrast.vocalDelta !== null && ` · vocal ${signed(contrast.vocalDelta)}`}
                    {contrast.registerDelta !== null && ` · register ${signed(contrast.registerDelta)}`}
                    {contrast.contourSimilarity !== null && ` · melodic shape ${Math.round(contrast.contourSimilarity * 100)}%`}
                  </p>
                  {contrast.similarity >= 0.88 && (
                    <p>
                      {contrast.toLabel} is highly similar to {contrast.fromLabel} across the measured arrangement features. Consider introducing
                      one new element here, or withholding one until the final chorus. Song Lab will not generate the element.
                    </p>
                  )}
                </div>
              ))
            )}
          </Card>

          <Card title="Vocal register">
            <RegisterPanel bands={data.registerBands} metrics={data.register} />
            {data.register.chorusRegisterLift !== null && Math.abs(data.register.chorusRegisterLift) < 0.05 && (
              <p>
                The chorus occupies nearly the same vocal register as the verse. That may contribute to lower perceived section
                contrast, or it may be exactly the intimacy this record wants — worth listening for, not a fault.
              </p>
            )}
          </Card>

          <Card title="Build intelligence">
            {data.builds.length === 0 ? (
              <div className="empty">No chorus, drop, bridge or breakdown entrances were identified.</div>
            ) : (
              data.builds.map((build) => (
                <div className="sl-build" key={`${build.approachLabel}-${build.targetLabel}`}>
                  <div className="sl-observation-head">
                    <span className="sl-timeline-time">{clock(build.startMs)}</span>
                    <strong>
                      {build.approachLabel.toUpperCase()} → {build.targetLabel.toUpperCase()}
                    </strong>
                    <Badge tone={build.band === 'strong' ? 'ok' : build.band === 'moderate' ? 'info' : 'warn'}>{build.band} transition</Badge>
                  </div>
                  <p>{build.observation}</p>
                  <ul className="sl-ideas">
                    {build.experimentIdeas.map((idea) => (
                      <li key={idea}>{idea}</li>
                    ))}
                  </ul>
                  {!build.renderableWithStems && (
                    <p className="faint">
                      These need separated stems to render as audio. This project has none, so they are offered as suggestions only.
                    </p>
                  )}
                </div>
              ))
            )}
          </Card>

          <Card title="Section-to-section contrast">
            <table>
              <thead>
                <tr>
                  <th>Transition</th>
                  <th>Similarity</th>
                  <th>Energy Δ</th>
                  <th>Spectral Δ</th>
                  <th>Low Δ</th>
                  <th>Transient Δ</th>
                  <th>Rhythmic Δ</th>
                  <th>Vocal Δ</th>
                  <th>Register Δ</th>
                  <th>Contour</th>
                </tr>
              </thead>
              <tbody>
                {data.consecutive.map((contrast) => (
                  <tr key={`${contrast.fromLabel}-${contrast.toLabel}`}>
                    <td>
                      {contrast.fromLabel} → {contrast.toLabel}
                    </td>
                    <td className="num">{Math.round(contrast.similarity * 100)}%</td>
                    <td className="num">{signed(contrast.energyDelta)}</td>
                    <td className="num">{signed(contrast.spectralDelta)}</td>
                    <td className="num">{signed(contrast.lowFrequencyDelta)}</td>
                    <td className="num">{signed(contrast.transientDelta)}</td>
                    <td className="num">{signed(contrast.rhythmicDelta)}</td>
                    <td className="num">{contrast.vocalDelta === null ? '—' : signed(contrast.vocalDelta)}</td>
                    <td className="num">{contrast.registerDelta === null ? '—' : signed(contrast.registerDelta)}</td>
                    <td className="num">{contrast.contourSimilarity === null ? '—' : `${Math.round(contrast.contourSimilarity * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

function signed(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

// ------------------------------------------------------------- benchmark ----

function BenchmarkTab({ projectId }: { projectId: string }) {
  const cohorts = useAsync(() => songLabApi.cohorts(), [])
  const state = useAsync(() => songLabApi.benchmark(projectId), [projectId])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const select = async (cohortId: string) => {
    setBusy(true)
    setError(null)
    try {
      await songLabApi.selectCohort(projectId, cohortId)
      state.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card title="Comparison cohort">
        <p className="faint">
          There is no universal hit-song formula, so Song Lab will not compare your record against one. Choose a group that this song is
          actually competing with — every percentile below is relative to it, and changing the group changes every finding.
        </p>
        <AsyncBlock state={cohorts}>
          {(data) => (
            <div className="sl-cohorts">
              {data.cohorts.map((cohort) => (
                <button
                  key={cohort.id}
                  className={`sl-cohort${state.data?.cohort?.id === cohort.id ? ' selected' : ''}`}
                  onClick={() => select(cohort.id)}
                  disabled={busy}
                >
                  <strong>{cohort.name}</strong>
                  <span className="faint">{cohort.definition || cohort.description}</span>
                  <span className="sl-cohort-meta">
                    n = {cohort.sampleSize}
                    {cohort.proprietary && <Badge tone="accent"> proprietary</Badge>}
                    {cohort.lowSample && <Badge tone="warn"> low sample</Badge>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </AsyncBlock>
        {error && <Callout tone="danger">{error}</Callout>}
      </Card>

      <AsyncBlock state={state}>
        {(data) =>
          !data.cohort ? (
            <Card>
              <div className="empty">{data.message ?? 'Select a comparison cohort above.'}</div>
            </Card>
          ) : (
            <>
              <LowSampleWarning sampleSize={data.sampleSize ?? data.cohort.sampleSize} />
              <Card title={`Against ${data.cohort.name}`} action={<span className="faint">{data.definition}</span>}>
                {data.results.length === 0 ? (
                  <div className="empty">No comparable metrics — this song and this cohort share no measured features.</div>
                ) : (
                  data.results.map((result) => <BenchmarkRow key={result.id} result={result} />)
                )}
              </Card>
              {data.provenance && data.provenance.length > 0 && (
                <Card title="Where this cohort's numbers come from">
                  <table>
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Kind</th>
                        <th>Basis</th>
                        <th>Captured</th>
                        <th>Stores masters</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.provenance.map((source) => (
                        <tr key={`${source.name}-${source.capturedAt}`}>
                          <td>{source.name}</td>
                          <td className="faint">{source.kind.replace(/_/g, ' ')}</td>
                          <td className="faint">{source.basis}</td>
                          <td className="faint">{new Date(source.capturedAt).toLocaleDateString()}</td>
                          <td>{source.storesMasters ? <Badge tone="danger">yes</Badge> : <Badge tone="ok">no</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
            </>
          )
        }
      </AsyncBlock>
    </>
  )
}

// ----------------------------------------------------------- experiments ----

function ExperimentsTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.experiments(projectId), [projectId])
  const structure = useAsync(() => songLabApi.structure(projectId).catch(() => null), [projectId])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const create = async (body: Parameters<typeof songLabApi.createExperiment>[1]) => {
    setBusy(true)
    setError(null)
    try {
      const result = await songLabApi.createExperiment(projectId, body)
      if (!result.experiment) setError(result.message ?? 'This idea cannot be rendered as audio.')
      state.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      state.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Card title="What if?">
            <p className="faint">
              Every experiment is a non-destructive edit list applied to your own recording. The original is never modified, and an experiment
              becomes a version of the song only when you accept it.
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="sl-experiment-buttons">
              <button className="small" disabled={busy} onClick={() => create({ experimentType: 'earlier_chorus', amount: 8, render: true })}>
                Earlier chorus
              </button>
              <button className="small" disabled={busy} onClick={() => create({ experimentType: 'shorter_intro', amount: 8, render: true })}>
                Shorter intro
              </button>
              <button className="small" disabled={busy} onClick={() => create({ experimentType: 'alternate_outro', repeatFinalHook: true, render: true })}>
                Alternate outro
              </button>
              {(structure.data?.sections ?? []).map((section) => (
                <button
                  key={section.id}
                  className="small"
                  disabled={busy}
                  onClick={() => create({ experimentType: 'section_cut', sectionOrderIndex: section.orderIndex, amount: 8, render: true })}
                >
                  Shorten {section.label}
                </button>
              ))}
            </div>
          </Card>

          <Card title="A / B">
            <AbPlayer
              tracks={[
                { id: 'original', label: 'Original', url: data.original?.url ?? null },
                ...data.experiments
                  .filter((experiment) => experiment.previewUrl)
                  .map((experiment) => ({
                    id: experiment.id,
                    label: experiment.name,
                    url: experiment.previewUrl ?? null,
                    note: experiment.placeholderPreview
                      ? 'Audio rendering is unavailable on this deployment, so this preview is silent. The edit list and predicted timings are real.'
                      : experiment.intent,
                  })),
              ]}
            />
          </Card>

          <Card title="Experiments">
            {data.experiments.length === 0 ? (
              <div className="empty">no experiments yet</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Predicted runtime</th>
                    <th>Status</th>
                    <th>Edits</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.experiments.map((experiment) => (
                    <tr key={experiment.id}>
                      <td>
                        <strong>{experiment.name}</strong>
                        <div className="faint">{experiment.intent}</div>
                      </td>
                      <td className="faint">{experiment.experimentType.replace(/_/g, ' ')}</td>
                      <td className="num">{clock(experiment.renderedDurationMs ?? experiment.predictedDurationMs)}</td>
                      <td>
                        <Badge tone={experiment.status === 'failed' ? 'danger' : experiment.status === 'accepted' ? 'ok' : 'info'}>
                          {experiment.status}
                        </Badge>
                        {experiment.placeholderPreview && <Badge tone="warn"> no audio preview</Badge>}
                      </td>
                      <td className="faint">
                        {experiment.editDecisionList.map((edit, index) => (
                          <div key={index}>{edit.note ?? edit.type.replace(/_/g, ' ')}</div>
                        ))}
                      </td>
                      <td>
                        <div className="button-row" style={{ margin: 0 }}>
                          {experiment.status === 'draft' && (
                            <button className="small" disabled={busy} onClick={() => act(() => songLabApi.renderExperiment(experiment.id))}>
                              Render
                            </button>
                          )}
                          {experiment.status === 'ready' && (
                            <>
                              {/* An experiment nobody could hear cannot be
                                  accepted — the button says why rather than
                                  failing on click. */}
                              <button
                                className="primary small"
                                disabled={busy || experiment.placeholderPreview}
                                title={
                                  experiment.placeholderPreview
                                    ? 'Audio rendering is unavailable on this deployment, so there is nothing to listen to before accepting this.'
                                    : undefined
                                }
                                onClick={() => act(() => songLabApi.acceptExperiment(experiment.id))}
                              >
                                Accept as version
                              </button>
                              <button className="small" disabled={busy} onClick={() => act(() => songLabApi.rejectExperiment(experiment.id))}>
                                Reject
                              </button>
                            </>
                          )}
                        </div>
                        {experiment.failureReason && <div className="faint">{experiment.failureReason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

// -------------------------------------------------------------- producer ----

function ProducerTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.producer(projectId), [projectId])
  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Card title="Analysis provenance">
            <table>
              <tbody>
                <tr>
                  <td className="faint">Engine version</td>
                  <td className="num">{data.engineVersion}</td>
                </tr>
                <tr>
                  <td className="faint">Source checksum</td>
                  <td className="num">{data.sourceChecksum.slice(0, 16)}…</td>
                </tr>
                {Object.entries(data.providers).map(([stage, provider]) => (
                  <tr key={stage}>
                    <td className="faint">{stage} provider</td>
                    <td className="num">
                      {provider.provider} · {provider.modelVersion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Raw features" action={<span className="faint">every figure with its method and confidence</span>}>
            <table>
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Value</th>
                  <th>Confidence</th>
                  <th>Method</th>
                  <th>Provider</th>
                </tr>
              </thead>
              <tbody>
                {data.features.map((feature) => (
                  <tr key={feature.key}>
                    <td>
                      {feature.label}
                      {feature.note && <div className="faint">{feature.note}</div>}
                    </td>
                    <td className="num">{feature.display}</td>
                    <td>
                      <ConfidencePill confidence={feature.confidence} />
                    </td>
                    <td className="faint">{feature.method}</td>
                    <td className="faint">
                      {feature.provider}
                      <div>{feature.modelVersion}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card
            title="Vocal register and melodic shape"
            action={<span className="faint">normalized band, not note names</span>}
          >
            <RegisterPanel
              bands={data.registerBands}
              metrics={{
                // The summary figures live in the feature vector, which the
                // Raw-features table above already prints in full — this panel
                // draws the bands, so it only needs the two it annotates.
                verseRegister: numeric(data.features, 'verse_register'),
                chorusRegister: numeric(data.features, 'chorus_register'),
                chorusRegisterLift: numeric(data.features, 'chorus_register_lift'),
                // The vector stores this one as a percentage; RegisterPanel
                // works in the engine's 0–1 ratio, so convert rather than
                // handing the same component two scales.
                melodicContourRepetition: ratioOf(numeric(data.features, 'melodic_contour_repetition')),
                vocalRegisterRange: numeric(data.features, 'vocal_register_range'),
                peakRegisterPosition: numeric(data.features, 'peak_register_position'),
                rhythmicContrast: numeric(data.features, 'rhythmic_contrast'),
                confidence: data.features.find((feature) => feature.key === 'chorus_register_lift')?.confidence ?? 0,
              }}
            />
            <ContourGrid bands={data.registerBands} />
          </Card>

          <Card title="Transition strength">
            <table>
              <thead>
                <tr>
                  <th>Transition</th>
                  <th>At</th>
                  <th>Strength</th>
                  <th>Pre-gap</th>
                </tr>
              </thead>
              <tbody>
                {data.builds.map((build) => (
                  <tr key={`${build.approachLabel}-${build.targetLabel}`}>
                    <td>
                      {build.approachLabel} → {build.targetLabel}
                    </td>
                    <td className="num">{clock(build.startMs)}</td>
                    <td className="num">{build.transitionStrength}</td>
                    <td className="num">{build.band}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

/** A percentage from the feature vector, back on the engine's 0–1 scale. */
function ratioOf(percent: number | null): number | null {
  return percent === null ? null : percent / 100
}

/** A feature-vector value by key, or null when it was not measured. */
function numeric(features: ProducerFeatureRow[], key: string): number | null {
  const value = features.find((feature) => feature.key === key)?.value
  return typeof value === 'number' ? value : null
}

/**
 * The melodic contours, drawn as sparklines.
 *
 * Producer View is the mode where a raw shape is more useful than a summary
 * number, so the contours are shown as themselves. Sections with too little
 * voiced content to have a shape are listed, not hidden — a gap in the grid is
 * information about the record.
 */
function ContourGrid({ bands }: { bands: SectionRegisterBand[] }) {
  const withContour = bands.filter((band) => band.contour.length > 1)
  if (withContour.length === 0) return null
  return (
    <div className="sl-contours">
      {withContour.map((band) => {
        const points = band.contour
          .map((value, index) => {
            const x = (index / Math.max(1, band.contour.length - 1)) * 100
            // Contours run -1..1 and SVG y grows downward, so a rising melody
            // has to be flipped to read as rising.
            const y = 20 - ((value + 1) / 2) * 20
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
        return (
          <div className="sl-contour" key={`${band.orderIndex}-${band.label}`}>
            <svg viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label={`Melodic contour for ${band.label}`}>
              <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="sl-contour-label">{band.label.toUpperCase()}</span>
          </div>
        )
      })}
    </div>
  )
}

// -------------------------------------------------------------- versions ----

function VersionsTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.versions(projectId), [projectId])
  const [a, setA] = React.useState('')
  const [b, setB] = React.useState('')
  const comparison = useAsync(
    () => (a && b ? songLabApi.compareVersions(projectId, a, b) : Promise.resolve(null)),
    [projectId, a, b],
  )
  const handoffs = useAsync(() => songLabApi.handoffs(projectId), [projectId])
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  const send = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    setMessage(null)
    try {
      await fn()
      setMessage(`Sent to ${label}.`)
      handoffs.reload()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Card title="Version lineage">
            <p className="faint">
              Nothing here overwrites anything. The original upload stays playable and analysable no matter how many experiments are accepted.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Type</th>
                  <th>From</th>
                  <th>Created</th>
                  <th>Compare</th>
                </tr>
              </thead>
              <tbody>
                {data.versions.map((version) => (
                  <tr key={version.id}>
                    <td>
                      <strong>{version.versionLabel}</strong>
                      <div className="faint">{version.notes}</div>
                    </td>
                    <td className="faint">{version.versionType.replace(/_/g, ' ')}</td>
                    <td className="faint">
                      {version.parentVersionId
                        ? data.versions.find((candidate) => candidate.id === version.parentVersionId)?.versionLabel ?? 'earlier version'
                        : '—'}
                    </td>
                    <td className="faint">{new Date(version.createdAt).toLocaleString()}</td>
                    <td>
                      <div className="button-row" style={{ margin: 0 }}>
                        <button className={a === version.id ? 'primary small' : 'small'} onClick={() => setA(version.id)}>
                          A
                        </button>
                        <button className={b === version.id ? 'primary small' : 'small'} onClick={() => setB(version.id)}>
                          B
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {a && b && (
            <AsyncBlock state={comparison}>
              {(compare) =>
                !compare ? (
                  <div className="empty">pick two versions</div>
                ) : (
                  <Card title={`${compare.a.version.versionLabel} → ${compare.b.version.versionLabel}`}>
                    <table>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>{compare.a.version.versionLabel}</th>
                          <th>{compare.b.version.versionLabel}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="faint">Runtime</td>
                          <td className="num">{clock(compare.a.analysis?.durationMs ?? null)}</td>
                          <td className="num">{clock(compare.b.analysis?.durationMs ?? null)}</td>
                        </tr>
                        <tr>
                          <td className="faint">Tempo</td>
                          <td className="num">{compare.a.analysis?.bpm ? `${Math.round(compare.a.analysis.bpm)} BPM` : '—'}</td>
                          <td className="num">{compare.b.analysis?.bpm ? `${Math.round(compare.b.analysis.bpm)} BPM` : '—'}</td>
                        </tr>
                        <tr>
                          <td className="faint">First chorus</td>
                          <td className="num">{firstChorus(compare.a.sections)}</td>
                          <td className="num">{firstChorus(compare.b.sections)}</td>
                        </tr>
                        <tr>
                          <td className="faint">Sections</td>
                          <td className="num">{compare.a.sections.length}</td>
                          <td className="num">{compare.b.sections.length}</td>
                        </tr>
                      </tbody>
                    </table>
                    <AbPlayer
                      tracks={[
                        { id: 'a', label: compare.a.version.versionLabel, url: compare.a.url },
                        { id: 'b', label: compare.b.version.versionLabel, url: compare.b.url },
                      ]}
                    />
                  </Card>
                )
              }
            </AsyncBlock>
          )}

          <Card title="Send onward">
            <p className="faint">
              Song Lab is the diagnostic layer. When the record is where you want it, hand the approved version to the module that takes it
              further — the snapshot travels with it.
            </p>
            {message && <Callout tone="info">{message}</Callout>}
            <div className="button-row">
              <button className="small" disabled={busy} onClick={() => send('Remix Lab', () => songLabApi.sendToRemixLab(projectId))}>
                SEND TO REMIX LAB
              </button>
              <button className="small" disabled={busy} onClick={() => send('Live Lab', () => songLabApi.sendToLiveLab(projectId))}>
                SEND TO LIVE LAB
              </button>
              <button
                className="small"
                disabled={busy}
                onClick={() => send('Release Command Center', () => songLabApi.sendToReleaseCommand(projectId))}
              >
                SEND TO RELEASE COMMAND CENTER
              </button>
              <button className="small" disabled={busy} onClick={() => send('review complete', () => songLabApi.markReviewComplete(projectId))}>
                SONG LAB REVIEW COMPLETE
              </button>
            </div>
            <AsyncBlock state={handoffs}>
              {(handoffData) =>
                handoffData.handoffs.length === 0 ? (
                  <div className="empty">nothing sent yet</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Target</th>
                        <th>Status</th>
                        <th>Record</th>
                        <th>Sent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {handoffData.handoffs.map((handoff) => (
                        <tr key={handoff.id}>
                          <td>{handoff.target.replace(/_/g, ' ')}</td>
                          <td>
                            <Badge tone={handoff.status === 'delivered' ? 'ok' : 'warn'}>{handoff.status}</Badge>
                          </td>
                          <td className="faint">{handoff.targetRecordId ?? '—'}</td>
                          <td className="faint">{new Date(handoff.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>
        </>
      )}
    </AsyncBlock>
  )
}

function firstChorus(sections: SongSection[]): string {
  const chorus = sections.find((section) => section.sectionType === 'chorus' || section.sectionType === 'final_chorus')
  return chorus ? clock(chorus.startMs) : '—'
}

// ------------------------------------------------------------------- A&R ----

/**
 * What the roster has learned, per recommendation type.
 *
 * The two columns are the entire point. A single median pooled across songs
 * that took a note and songs that ignored it describes neither group, so the
 * groups are shown apart and a metric with too few releases behind it shows
 * its count instead of a number.
 */
function RecommendationLearning() {
  const state = useAsync(() => songLabApi.recommendationOutcomes(), [])

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <Card title="What the roster has learned" action={<span className="faint">{data.summary.length} recommendation types</span>}>
          {data.summary.length === 0 ? (
            <div className="empty">No recommendation has been released and measured yet.</div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Recommendation</th>
                      <th className="num">Suggested</th>
                      <th className="num">Accepted</th>
                      <th className="num">Implemented</th>
                      <th className="num">Released</th>
                      <th>Implemented</th>
                      <th>Not implemented</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.map((row) => (
                      <tr key={row.recommendationType}>
                        <td>{row.recommendationType.replace(/_/g, ' ')}</td>
                        <td className="num">{row.suggested}</td>
                        <td className="num">{row.accepted}</td>
                        <td className="num">{row.implemented}</td>
                        <td className="num">{row.released}</td>
                        <td>
                          <OutcomeMetrics group={row.implementedOutcome} />
                        </td>
                        <td>
                          <OutcomeMetrics group={row.notImplementedOutcome} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Callout tone="info">{data.note}</Callout>
            </>
          )}
        </Card>
      )}
    </AsyncBlock>
  )
}

function OutcomeMetrics({ group }: { group: { sampleSize: number; metrics: Record<string, Measured> } }) {
  const entries = Object.entries(group.metrics)
  if (entries.length === 0) return <span className="faint">no releases</span>
  return (
    <>
      {entries.map(([key, value]) => (
        <div key={key}>
          <span className="faint">{key.replace(/_/g, ' ')}: </span>
          {value.value === null ? (
            // The count, not a dash: "n = 3" says why the number is missing.
            <span className="faint" title={value.note}>
              not enough information (n&nbsp;=&nbsp;{group.sampleSize})
            </span>
          ) : (
            <>
              {value.value.toLocaleString()} <span className="faint">(n&nbsp;=&nbsp;{group.sampleSize})</span>
            </>
          )}
        </div>
      ))}
    </>
  )
}

function ArTab({ projectId }: { projectId: string }) {
  const state = useAsync(() => songLabApi.ar(projectId), [projectId])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [why, setWhy] = React.useState('')

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      state.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={state}>
      {(data) => (
        <>
          <Callout tone="info" title="Internal — Street Banker only">
            This view is permission controlled and is not shown to artist users. Every rating below is traceable to measured features and a
            cohort comparison, and no rating is a decision until a person approves it.
          </Callout>

          <div style={{ marginBottom: 16 }}>
            <RecommendationLearning />
          </div>

          {error && <Callout tone="danger">{error}</Callout>}

          {!data.review ? (
            <Card title="No assessment yet">
              <button className="primary" disabled={busy} onClick={() => act(() => songLabApi.draftAr(projectId))}>
                Draft an assessment from the evidence
              </button>
            </Card>
          ) : (
            <>
              <Card
                title={`Assessment — ${data.review.status}`}
                action={<Badge tone={data.review.status === 'approved' ? 'ok' : 'warn'}>{data.review.status}</Badge>}
              >
                <div className="sl-ar-grid">
                  {(
                    [
                      ['Song structure', data.review.structureRating],
                      ['Hook architecture', data.review.hookRating],
                      ['Early payoff', data.review.earlyPayoffRating],
                      ['Arrangement contrast', data.review.arrangementContrastRating],
                      ['Vocal memorability', data.review.vocalMemorabilityRating],
                      ['Streaming format fit', data.review.streamingFitRating],
                      ['Live potential', data.review.livePotentialRating],
                      ['Sync structure', data.review.syncPotentialRating],
                    ] as const
                  ).map(([label, rating]) => (
                    <div className="sl-ar-cell" key={label}>
                      <div className="sl-ar-label">{label.toUpperCase()}</div>
                      <div className="sl-ar-rating">{rating.replace(/_/g, ' ')}</div>
                    </div>
                  ))}
                </div>
                <div className="sl-ar-recommendation">
                  <div className="sl-ar-label">RECOMMENDATION</div>
                  <div className="sl-ar-rating accent">{data.review.recommendation.replace(/_/g, ' ').toUpperCase()}</div>
                  <ConfidencePill confidence={data.review.confidence} />
                </div>
              </Card>

              <Card title="Why">
                <p>{data.review.why}</p>
                <table>
                  <thead>
                    <tr>
                      <th>Dimension</th>
                      <th>Evidence</th>
                      <th>Metrics</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.review.evidence.map((entry) => (
                      <tr key={entry.dimension}>
                        <td>{entry.dimension.replace(/_/g, ' ')}</td>
                        <td className="faint">{entry.note}</td>
                        <td className="faint">{entry.metricKeys.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <Field label="Override the why panel" hint="operator judgement replaces the drafted text">
                  <textarea rows={4} value={why} onChange={(event) => setWhy(event.target.value)} placeholder={data.review.why} />
                </Field>
                <div className="button-row">
                  <button
                    className="small"
                    disabled={busy || why.trim().length === 0}
                    onClick={() => act(() => songLabApi.updateAr(data.review!.id, { why }))}
                  >
                    Save override
                  </button>
                  <select
                    defaultValue={data.review.recommendation}
                    onChange={(event) => act(() => songLabApi.updateAr(data.review!.id, { recommendation: event.target.value }))}
                    disabled={busy}
                    style={{ width: 240 }}
                  >
                    {data.recommendations.map((option) => (
                      <option key={option} value={option}>
                        {option.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                  {data.review.status === 'draft' && (
                    <button className="primary small" disabled={busy} onClick={() => act(() => songLabApi.approveAr(data.review!.id))}>
                      Approve as a human decision
                    </button>
                  )}
                  <button className="small" disabled={busy} onClick={() => act(() => songLabApi.draftAr(projectId))}>
                    Re-draft from current evidence
                  </button>
                </div>
                {data.review.reviewedBy && (
                  <p className="faint">
                    Approved by {data.review.reviewedBy} on {data.review.reviewedAt ? new Date(data.review.reviewedAt).toLocaleString() : ''}.
                  </p>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </AsyncBlock>
  )
}
