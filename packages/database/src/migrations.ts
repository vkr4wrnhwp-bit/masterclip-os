/**
 * Migrations are inlined TypeScript rather than loose `.sql` files so the
 * production bundles (esbuild) stay self-contained with no runtime file lookup.
 *
 * The DDL is deliberately written in the intersection of SQLite and
 * PostgreSQL:
 *   - types are limited to TEXT / INTEGER / BIGINT / REAL;
 *   - booleans are 0/1 INTEGER;
 *   - timestamps are ISO-8601 TEXT (sortable, timezone-explicit);
 *   - JSON is TEXT, parsed in the repository layer;
 *   - no DEFAULT expressions — the application supplies every value, so both
 *     dialects agree on what a row contains.
 */
export interface Migration {
  id: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    sql: `
-- ===========================================================================
-- identity and tenancy
-- ===========================================================================
CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  org_role      TEXT NOT NULL,
  disabled      INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ===========================================================================
-- projects, scenes, shots
-- ===========================================================================
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  brief         TEXT NOT NULL,
  style_bible   TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(org_id, slug);

CREATE TABLE IF NOT EXISTS project_members (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  member_role   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS scenes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  name          TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  synopsis      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id, ordinal);

CREATE TABLE IF NOT EXISTS shots (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  scene_id        TEXT REFERENCES scenes(id),
  shot_key        TEXT NOT NULL,
  title           TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_key ON shots(project_id, shot_key);
CREATE INDEX IF NOT EXISTS idx_shots_scene ON shots(scene_id, ordinal);

-- Every render points at an immutable shot_versions row. That is what makes a
-- master's provenance meaningful: the spec it was generated from cannot drift.
CREATE TABLE IF NOT EXISTS shot_versions (
  id            TEXT PRIMARY KEY,
  shot_id       TEXT NOT NULL REFERENCES shots(id),
  version       INTEGER NOT NULL,
  spec          TEXT NOT NULL,
  spec_hash     TEXT NOT NULL,
  note          TEXT NOT NULL,
  locked        INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shot_versions ON shot_versions(shot_id, version);

-- ===========================================================================
-- character bible / world bible
-- ===========================================================================
CREATE TABLE IF NOT EXISTS characters (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  character_key   TEXT NOT NULL,
  name            TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  rights_status   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_key ON characters(project_id, character_key);

CREATE TABLE IF NOT EXISTS character_versions (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id),
  version       INTEGER NOT NULL,
  data          TEXT NOT NULL,
  data_hash     TEXT NOT NULL,
  locked        INTEGER NOT NULL,
  note          TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_versions ON character_versions(character_id, version);

CREATE TABLE IF NOT EXISTS environments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  environment_key TEXT NOT NULL,
  name            TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_key ON environments(project_id, environment_key);

CREATE TABLE IF NOT EXISTS environment_versions (
  id              TEXT PRIMARY KEY,
  environment_id  TEXT NOT NULL REFERENCES environments(id),
  version         INTEGER NOT NULL,
  data            TEXT NOT NULL,
  data_hash       TEXT NOT NULL,
  locked          INTEGER NOT NULL,
  note            TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_versions ON environment_versions(environment_id, version);

-- ===========================================================================
-- assets, rights, lineage
-- ===========================================================================
CREATE TABLE IF NOT EXISTS assets (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  kind              TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  filename          TEXT NOT NULL,
  mime              TEXT NOT NULL,
  bytes             BIGINT NOT NULL,
  sha256            TEXT NOT NULL,
  width             INTEGER,
  height            INTEGER,
  duration_seconds  REAL,
  fps               REAL,
  has_audio         INTEGER,
  metadata          TEXT NOT NULL,
  rights_owner      TEXT NOT NULL,
  rights_source     TEXT NOT NULL,
  rights_license    TEXT NOT NULL,
  rights_consent    TEXT NOT NULL,
  rights_allowed_use TEXT NOT NULL,
  rights_expires_at TEXT,
  rights_notes      TEXT NOT NULL,
  rights_authorized INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(project_id, sha256);

CREATE TABLE IF NOT EXISTS asset_lineage (
  id              TEXT PRIMARY KEY,
  child_asset_id  TEXT NOT NULL REFERENCES assets(id),
  parent_asset_id TEXT NOT NULL REFERENCES assets(id),
  relation        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_child ON asset_lineage(child_asset_id);
CREATE INDEX IF NOT EXISTS idx_lineage_parent ON asset_lineage(parent_asset_id);

-- Provider-side copies of our references, so the same image is uploaded once
-- per provider instead of once per render.
CREATE TABLE IF NOT EXISTS provider_asset_cache (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL,
  asset_id        TEXT NOT NULL REFERENCES assets(id),
  sha256          TEXT NOT NULL,
  remote_ref      TEXT NOT NULL,
  expires_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_asset_cache ON provider_asset_cache(provider_id, sha256);

-- ===========================================================================
-- provider catalog + health + credentials
-- ===========================================================================
CREATE TABLE IF NOT EXISTS provider_models (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  family          TEXT NOT NULL,
  modes           TEXT NOT NULL,
  capabilities    TEXT NOT NULL,
  pricing         TEXT NOT NULL,
  raw             TEXT NOT NULL,
  enabled         INTEGER NOT NULL,
  source          TEXT NOT NULL,
  fetched_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_models ON provider_models(provider_id, model_id);

CREATE TABLE IF NOT EXISTS provider_health (
  provider_id           TEXT PRIMARY KEY,
  status                TEXT NOT NULL,
  latency_ms            INTEGER,
  message               TEXT NOT NULL,
  consecutive_failures  INTEGER NOT NULL,
  checked_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  provider_id     TEXT NOT NULL,
  label           TEXT NOT NULL,
  encrypted_key   TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  mode            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_credentials ON provider_credentials(org_id, provider_id);

-- ===========================================================================
-- money: quotes, budgets, append-only ledger
-- ===========================================================================
CREATE TABLE IF NOT EXISTS price_quotes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id),
  shot_id           TEXT REFERENCES shots(id),
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  estimated_micros  BIGINT NOT NULL,
  credits           REAL,
  currency          TEXT NOT NULL,
  source            TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  raw               TEXT NOT NULL,
  quoted_at         TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_hash ON price_quotes(request_hash);

CREATE TABLE IF NOT EXISTS budgets (
  id                            TEXT PRIMARY KEY,
  scope                         TEXT NOT NULL,
  scope_id                      TEXT NOT NULL,
  daily_cap_micros              BIGINT,
  monthly_cap_micros            BIGINT,
  lifetime_cap_micros           BIGINT,
  per_shot_cap_micros           BIGINT,
  max_attempts                  INTEGER,
  max_premium_attempts          INTEGER,
  warn_threshold_pct            REAL NOT NULL,
  approval_required_above_micros BIGINT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope, scope_id);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  project_id          TEXT,
  scene_id            TEXT,
  shot_id             TEXT,
  batch_id            TEXT,
  job_id              TEXT,
  attempt_id          TEXT,
  output_id           TEXT,
  provider_id         TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  entry_type          TEXT NOT NULL,
  micros              BIGINT NOT NULL,
  credits             REAL,
  billable_seconds    REAL,
  quote_id            TEXT,
  external_request_id TEXT,
  -- Sandbox spend is tracked with the same machinery but never counts against
  -- the live-spend cap, so the whole cost pipeline is exercisable for free.
  sandbox             INTEGER NOT NULL,
  note                TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_project ON cost_ledger(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_org_day ON cost_ledger(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_job ON cost_ledger(job_id);

CREATE TABLE IF NOT EXISTS budget_events (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  event       TEXT NOT NULL,
  micros      BIGINT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budget_events ON budget_events(scope, scope_id, created_at);

-- ===========================================================================
-- render factory
-- ===========================================================================
CREATE TABLE IF NOT EXISTS render_batches (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,
  matrix            TEXT NOT NULL,
  estimated_micros  BIGINT NOT NULL,
  actual_micros     BIGINT NOT NULL,
  stop_loss_micros  BIGINT,
  candidate_count   INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  cancelled_at      TEXT,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON render_batches(project_id, created_at);

CREATE TABLE IF NOT EXISTS render_jobs (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT REFERENCES render_batches(id),
  project_id        TEXT NOT NULL REFERENCES projects(id),
  scene_id          TEXT,
  shot_id           TEXT NOT NULL REFERENCES shots(id),
  shot_version_id   TEXT NOT NULL REFERENCES shot_versions(id),
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  routing_profile   TEXT NOT NULL,
  compiled_prompt   TEXT NOT NULL,
  request           TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL,
  external_job_id   TEXT,
  quote_id          TEXT,
  estimated_micros  BIGINT NOT NULL,
  actual_micros     BIGINT NOT NULL,
  attempts          INTEGER NOT NULL,
  seed              TEXT,
  sandbox           INTEGER NOT NULL,
  priority          INTEGER NOT NULL,
  error             TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  submitted_at      TEXT,
  completed_at      TEXT,
  failed_at         TEXT,
  cancelled_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON render_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON render_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON render_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_external ON render_jobs(provider_id, external_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_shot ON render_jobs(shot_id);

CREATE TABLE IF NOT EXISTS render_attempts (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES render_jobs(id),
  attempt           INTEGER NOT NULL,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  status            TEXT NOT NULL,
  external_job_id   TEXT,
  estimated_micros  BIGINT NOT NULL,
  actual_micros     BIGINT NOT NULL,
  billable          INTEGER NOT NULL,
  latency_ms        INTEGER,
  error             TEXT,
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts ON render_attempts(job_id, attempt);

CREATE TABLE IF NOT EXISTS outputs (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES render_jobs(id),
  attempt_id        TEXT REFERENCES render_attempts(id),
  project_id        TEXT NOT NULL,
  shot_id           TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES assets(id),
  proxy_asset_id    TEXT,
  thumbnail_asset_id TEXT,
  contact_sheet_asset_id TEXT,
  output_index      INTEGER NOT NULL,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  duration_seconds  REAL,
  width             INTEGER,
  height            INTEGER,
  fps               REAL,
  has_audio         INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  status            TEXT NOT NULL,
  metadata          TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outputs_job ON outputs(job_id);
CREATE INDEX IF NOT EXISTS idx_outputs_shot ON outputs(shot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outputs_sha ON outputs(project_id, sha256);

CREATE TABLE IF NOT EXISTS output_qc (
  id                  TEXT PRIMARY KEY,
  output_id           TEXT NOT NULL REFERENCES outputs(id),
  layer               TEXT NOT NULL,
  engine              TEXT NOT NULL,
  technical_pass      INTEGER NOT NULL,
  creative_score      REAL,
  identity_score      REAL,
  continuity_score    REAL,
  motion_score        REAL,
  realism_score       REAL,
  recommended_action  TEXT NOT NULL,
  confidence          REAL NOT NULL,
  hard_failures       TEXT NOT NULL,
  warnings            TEXT NOT NULL,
  raw                 TEXT NOT NULL,
  cost_micros         BIGINT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qc_output ON output_qc(output_id, layer);

CREATE TABLE IF NOT EXISTS reviews (
  id                TEXT PRIMARY KEY,
  output_id         TEXT NOT NULL REFERENCES outputs(id),
  project_id        TEXT NOT NULL,
  shot_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  decision          TEXT NOT NULL,
  rank_order        INTEGER,
  rejection_reasons TEXT NOT NULL,
  note              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_output ON reviews(output_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_shot ON reviews(shot_id, created_at);

CREATE TABLE IF NOT EXISTS masters (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  scene_id        TEXT,
  shot_id         TEXT NOT NULL,
  output_id       TEXT NOT NULL REFERENCES outputs(id),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  master_asset_id TEXT,
  approved_by     TEXT NOT NULL,
  approved_at     TEXT NOT NULL,
  metadata        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_masters_project ON masters(project_id, created_at);

CREATE TABLE IF NOT EXISTS master_deliverables (
  id          TEXT PRIMARY KEY,
  master_id   TEXT NOT NULL REFERENCES masters(id),
  format      TEXT NOT NULL,
  asset_id    TEXT NOT NULL REFERENCES assets(id),
  spec        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliverables_master ON master_deliverables(master_id);

-- ===========================================================================
-- durable queue
-- ===========================================================================
CREATE TABLE IF NOT EXISTS queue_jobs (
  id            TEXT PRIMARY KEY,
  queue_name    TEXT NOT NULL,
  job_type      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL,
  priority      INTEGER NOT NULL,
  run_at        TEXT NOT NULL,
  attempts      INTEGER NOT NULL,
  max_attempts  INTEGER NOT NULL,
  lease_until   TEXT,
  locked_by     TEXT,
  dedupe_key    TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_claim ON queue_jobs(queue_name, status, run_at, priority);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedupe ON queue_jobs(dedupe_key);

CREATE TABLE IF NOT EXISTS queue_dead (
  id            TEXT PRIMARY KEY,
  original_id   TEXT NOT NULL,
  queue_name    TEXT NOT NULL,
  job_type      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  attempts      INTEGER NOT NULL,
  last_error    TEXT NOT NULL,
  failed_at     TEXT NOT NULL,
  replayed_at   TEXT
);

-- ===========================================================================
-- webhooks, audit, learning
-- ===========================================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_dedupe ON webhook_events(provider_id, dedupe_key);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  project_id  TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

-- Rolling acceptance statistics that feed the router's expected-approved-cost
-- ranking. Derived data: rebuildable from reviews + cost_ledger at any time.
CREATE TABLE IF NOT EXISTS model_performance (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  provider_id         TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  shot_category       TEXT NOT NULL,
  submitted           INTEGER NOT NULL,
  technically_valid   INTEGER NOT NULL,
  approved            INTEGER NOT NULL,
  rejected            INTEGER NOT NULL,
  total_micros        BIGINT NOT NULL,
  approved_micros     BIGINT NOT NULL,
  approved_seconds    REAL NOT NULL,
  submitted_seconds   REAL NOT NULL,
  latency_ms_total    BIGINT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_perf ON model_performance(project_id, provider_id, model_id, shot_category);

CREATE TABLE IF NOT EXISTS rejection_stats (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  count_n       INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rejection_stats ON rejection_stats(project_id, provider_id, model_id, reason);
`,
  },
  {
    id: '0002_agent_runs',
    sql: `
-- Claude agent invocations: what was asked, what came back, what it cost.
CREATE TABLE IF NOT EXISTS agent_runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT,
  agent           TEXT NOT NULL,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL,
  input           TEXT NOT NULL,
  output          TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_micros     BIGINT NOT NULL,
  latency_ms      INTEGER NOT NULL,
  error           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, created_at);
`,
  },
  {
    id: '0003_live_lab',
    sql: `
-- ===========================================================================
-- Live Lab — live-performance projects. Every table is organization scoped:
-- org_id is checked in the API layer on every access, and the tests assert
-- that records can never cross a tenant boundary.
-- ===========================================================================

-- Feature entitlements (Partner OS seam). One row per (org, capability) and
-- per (org, limit key). Enforced server-side; hiding UI is not enforcement.
CREATE TABLE IF NOT EXISTS org_entitlements (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  capability    TEXT NOT NULL,
  enabled       INTEGER NOT NULL,
  limit_value   BIGINT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_entitlements ON org_entitlements(org_id, capability);

CREATE TABLE IF NOT EXISTS live_projects (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id),
  artist_id          TEXT,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  status             TEXT NOT NULL,
  master_tempo       REAL NOT NULL,
  time_signature     TEXT NOT NULL,
  source_release_ids TEXT NOT NULL,
  pad_map            TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_projects_org ON live_projects(org_id, created_at);

CREATE TABLE IF NOT EXISTS live_set_items (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id),
  live_project_id    TEXT NOT NULL REFERENCES live_projects(id),
  sort_order         INTEGER NOT NULL,
  item_type          TEXT NOT NULL,
  title              TEXT NOT NULL,
  source_release_id  TEXT,
  source_track_id    TEXT,
  bpm                REAL,
  song_key           TEXT,
  duration_ms        BIGINT,
  notes              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_set_items ON live_set_items(live_project_id, sort_order);

CREATE TABLE IF NOT EXISTS live_scenes (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES orgs(id),
  live_project_id        TEXT NOT NULL REFERENCES live_projects(id),
  live_set_item_id       TEXT NOT NULL REFERENCES live_set_items(id),
  name                   TEXT NOT NULL,
  scene_type             TEXT NOT NULL,
  sort_order             INTEGER NOT NULL,
  color                  TEXT NOT NULL,
  bpm                    REAL,
  song_key               TEXT,
  bars                   INTEGER,
  quantization           TEXT NOT NULL,
  loop_enabled           INTEGER NOT NULL,
  follow_action          TEXT NOT NULL,
  follow_target_scene_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_scenes_item ON live_scenes(live_set_item_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_live_scenes_project ON live_scenes(live_project_id);

-- Live Lab audio files. Separate from the video 'assets' table on purpose:
-- live assets are org+live-project scoped, carry performance metadata, and
-- keep AI generation lineage inline.
CREATE TABLE IF NOT EXISTS live_assets (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  live_project_id  TEXT NOT NULL REFERENCES live_projects(id),
  kind             TEXT NOT NULL,
  storage_key      TEXT NOT NULL,
  filename         TEXT NOT NULL,
  mime             TEXT NOT NULL,
  bytes            BIGINT NOT NULL,
  sha256           TEXT NOT NULL,
  duration_ms      BIGINT,
  metadata         TEXT NOT NULL,
  rights_owner     TEXT NOT NULL,
  rights_confirmed INTEGER NOT NULL,
  rights_confirmed_by TEXT,
  rights_confirmed_at TEXT,
  lineage          TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_assets_project ON live_assets(live_project_id, kind);

CREATE TABLE IF NOT EXISTS live_clips (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  live_project_id  TEXT NOT NULL REFERENCES live_projects(id),
  live_scene_id    TEXT NOT NULL REFERENCES live_scenes(id),
  name             TEXT NOT NULL,
  source_asset_id  TEXT NOT NULL REFERENCES live_assets(id),
  start_ms         BIGINT NOT NULL,
  end_ms           BIGINT,
  loop_start_ms    BIGINT,
  loop_end_ms      BIGINT,
  one_shot         INTEGER NOT NULL,
  gain             REAL NOT NULL,
  pan              REAL NOT NULL,
  output_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_clips_scene ON live_clips(live_scene_id);

CREATE TABLE IF NOT EXISTS live_stems (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  live_project_id  TEXT NOT NULL REFERENCES live_projects(id),
  live_set_item_id TEXT NOT NULL REFERENCES live_set_items(id),
  stem_type        TEXT NOT NULL,
  label            TEXT NOT NULL,
  source_asset_id  TEXT NOT NULL REFERENCES live_assets(id),
  gain             REAL NOT NULL,
  pan              REAL NOT NULL,
  muted            INTEGER NOT NULL,
  solo             INTEGER NOT NULL,
  output_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_stems_item ON live_stems(live_set_item_id);

CREATE TABLE IF NOT EXISTS live_midi_mappings (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id),
  live_project_id    TEXT NOT NULL REFERENCES live_projects(id),
  device_identifier  TEXT NOT NULL,
  channel            INTEGER NOT NULL,
  message_type       TEXT NOT NULL,
  note_or_controller INTEGER NOT NULL,
  target_type        TEXT NOT NULL,
  target_id          TEXT,
  minimum            REAL NOT NULL,
  maximum            REAL NOT NULL,
  inversion          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_midi_project ON live_midi_mappings(live_project_id);

CREATE TABLE IF NOT EXISTS live_outputs (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  live_project_id  TEXT NOT NULL REFERENCES live_projects(id),
  name             TEXT NOT NULL,
  output_type      TEXT NOT NULL,
  device_id        TEXT,
  channel_index    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_live_outputs_project ON live_outputs(live_project_id);

CREATE TABLE IF NOT EXISTS live_ai_jobs (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  live_project_id       TEXT NOT NULL REFERENCES live_projects(id),
  live_set_item_id      TEXT,
  source_asset_id       TEXT,
  provider              TEXT NOT NULL,
  operation             TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  configuration         TEXT NOT NULL,
  status                TEXT NOT NULL,
  output_asset_ids      TEXT NOT NULL,
  error                 TEXT,
  estimated_cost_micros BIGINT NOT NULL,
  final_cost_micros     BIGINT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_ai_jobs_project ON live_ai_jobs(live_project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_live_ai_jobs_org_month ON live_ai_jobs(org_id, created_at);

CREATE TABLE IF NOT EXISTS live_performance_packages (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  live_project_id  TEXT NOT NULL REFERENCES live_projects(id),
  version          INTEGER NOT NULL,
  status           TEXT NOT NULL,
  manifest         TEXT NOT NULL,
  storage_size     BIGINT NOT NULL,
  created_at       TEXT NOT NULL,
  verified_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_packages ON live_performance_packages(live_project_id, version);

CREATE TABLE IF NOT EXISTS live_performance_events (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES orgs(id),
  live_project_id        TEXT NOT NULL REFERENCES live_projects(id),
  performance_package_id TEXT,
  event_type             TEXT NOT NULL,
  payload                TEXT NOT NULL,
  local_timestamp        TEXT NOT NULL,
  synchronized_at        TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_events_project ON live_performance_events(live_project_id, created_at);
`,
  },
  {
    id: '0004_audio_intelligence',
    sql: `
-- ===========================================================================
-- Street Banker Audio Intelligence
--
-- Every tenant-owned table carries org_id and every repository method filters
-- by it. Provider names appear only in data columns, never in table names —
-- the provider is replaceable infrastructure.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS audio_data_policies (
  id                              TEXT PRIMARY KEY,
  org_id                          TEXT NOT NULL REFERENCES orgs(id),
  allow_audio_upload              INTEGER NOT NULL,
  allow_meeting_recording         INTEGER NOT NULL,
  allow_call_recording            INTEGER NOT NULL,
  allow_transcription             INTEGER NOT NULL,
  allow_voice_generation          INTEGER NOT NULL,
  allow_dubbing                   INTEGER NOT NULL,
  allow_music_generation          INTEGER NOT NULL,
  allow_voice_cloning             INTEGER NOT NULL,
  require_zero_retention          INTEGER NOT NULL,
  allow_provider_storage          INTEGER NOT NULL,
  allow_internal_storage          INTEGER NOT NULL,
  source_audio_retention_days     INTEGER,
  transcript_retention_days       INTEGER,
  generated_audio_retention_days  INTEGER,
  agent_conversation_retention_days INTEGER,
  voice_sample_retention_days     INTEGER,
  allow_human_review              INTEGER NOT NULL,
  allow_ai_extraction             INTEGER NOT NULL,
  allow_download                  INTEGER NOT NULL,
  allow_export                    INTEGER NOT NULL,
  require_recording_consent       INTEGER NOT NULL,
  require_agent_disclosure        INTEGER NOT NULL,
  require_rights_confirmation     INTEGER NOT NULL,
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_policy_org ON audio_data_policies(org_id);

-- Org-level audio settings: default providers, protected names for prompt
-- moderation, white-label operator branding. JSON columns parsed in the repo.
CREATE TABLE IF NOT EXISTS org_audio_settings (
  org_id            TEXT PRIMARY KEY REFERENCES orgs(id),
  default_providers TEXT NOT NULL,
  protected_names   TEXT NOT NULL,
  white_label       TEXT NOT NULL,
  feature_toggles   TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Partner OS entitlements: which audio.* capabilities an org holds. The
-- flagship org administers these; enabled lets an org admin switch a granted
-- capability off without losing the grant.
CREATE TABLE IF NOT EXISTS org_audio_entitlements (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  capability  TEXT NOT NULL,
  enabled     INTEGER NOT NULL,
  granted_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_entitlements ON org_audio_entitlements(org_id, capability);

CREATE TABLE IF NOT EXISTS audio_keyterms (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  term        TEXT NOT NULL,
  category    TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_keyterms ON audio_keyterms(org_id, term);

CREATE TABLE IF NOT EXISTS consent_records (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  consent_type    TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  accepted        INTEGER NOT NULL,
  accepted_by     TEXT NOT NULL,
  accepted_at     TEXT NOT NULL,
  revoked_at      TEXT,
  evidence        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_subject ON consent_records(org_id, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS audio_assets (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  owner_user_id         TEXT NOT NULL,
  project_type          TEXT NOT NULL,
  project_id            TEXT,
  asset_type            TEXT NOT NULL,
  storage_key           TEXT NOT NULL,
  file_name             TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  file_size             BIGINT NOT NULL,
  duration_ms           INTEGER,
  checksum              TEXT NOT NULL,
  rights_status         TEXT NOT NULL,
  consent_record_id     TEXT,
  retention_kind        TEXT NOT NULL,
  retention_expires_at  TEXT,
  deleted_at            TEXT,
  delete_reason         TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_assets_org ON audio_assets(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audio_assets_project ON audio_assets(org_id, project_type, project_id);
CREATE INDEX IF NOT EXISTS idx_audio_assets_checksum ON audio_assets(org_id, checksum);
CREATE INDEX IF NOT EXISTS idx_audio_assets_retention ON audio_assets(retention_expires_at);

-- Generation lineage: which provider/model/voice/prompt produced an asset,
-- under which rights basis, derived from which parent.
CREATE TABLE IF NOT EXISTS audio_generations (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  project_type          TEXT NOT NULL,
  project_id            TEXT,
  output_asset_id       TEXT NOT NULL REFERENCES audio_assets(id),
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  operation             TEXT NOT NULL,
  voice_profile_id      TEXT,
  prompt                TEXT NOT NULL,
  configuration         TEXT NOT NULL,
  rights_basis          TEXT NOT NULL,
  consent_record_id     TEXT,
  parent_generation_id  TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_generations_project ON audio_generations(org_id, project_type, project_id);
CREATE INDEX IF NOT EXISTS idx_audio_generations_asset ON audio_generations(output_asset_id);

CREATE TABLE IF NOT EXISTS audio_jobs (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  user_id               TEXT NOT NULL,
  feature_key           TEXT NOT NULL,
  provider              TEXT NOT NULL,
  operation             TEXT NOT NULL,
  provider_job_id       TEXT,
  status                TEXT NOT NULL,
  input_asset_ids       TEXT NOT NULL,
  output_asset_ids      TEXT NOT NULL,
  configuration         TEXT NOT NULL,
  estimated_cost_micros BIGINT NOT NULL,
  final_cost_micros     BIGINT NOT NULL,
  error_code            TEXT,
  error_message         TEXT,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_org ON audio_jobs(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_status ON audio_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_provider ON audio_jobs(provider, provider_job_id);

CREATE TABLE IF NOT EXISTS audio_transcripts (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  audio_asset_id        TEXT NOT NULL REFERENCES audio_assets(id),
  provider              TEXT NOT NULL,
  language              TEXT NOT NULL,
  language_confidence   REAL,
  full_text             TEXT NOT NULL,
  confidence            REAL,
  status                TEXT NOT NULL,
  raw                   TEXT NOT NULL,
  retention_expires_at  TEXT,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_transcripts_org ON audio_transcripts(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audio_transcripts_asset ON audio_transcripts(audio_asset_id);
CREATE INDEX IF NOT EXISTS idx_audio_transcripts_retention ON audio_transcripts(retention_expires_at);

CREATE TABLE IF NOT EXISTS audio_transcript_segments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  transcript_id TEXT NOT NULL REFERENCES audio_transcripts(id),
  speaker_key   TEXT,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  seg_text      TEXT NOT NULL,
  confidence    REAL,
  entities      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcript_segments ON audio_transcript_segments(transcript_id, start_ms);

CREATE TABLE IF NOT EXISTS audio_transcript_speakers (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  transcript_id         TEXT NOT NULL REFERENCES audio_transcripts(id),
  provider_speaker_key  TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  person_id             TEXT,
  manually_confirmed    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_speakers ON audio_transcript_speakers(transcript_id, provider_speaker_key);

-- ===========================================================================
-- Operator Desk scaffold: leads, notes, tasks that approved intelligence
-- commits into. Nothing commits here without a human approval step.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS operator_leads (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  name          TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  artist_name   TEXT NOT NULL,
  stage         TEXT NOT NULL,
  source        TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_leads_org ON operator_leads(org_id, updated_at);

CREATE TABLE IF NOT EXISTS operator_notes (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  lead_id     TEXT NOT NULL REFERENCES operator_leads(id),
  body        TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  pinned      INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_notes_lead ON operator_notes(lead_id, created_at);

CREATE TABLE IF NOT EXISTS operator_tasks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  lead_id           TEXT NOT NULL REFERENCES operator_leads(id),
  description       TEXT NOT NULL,
  status            TEXT NOT NULL,
  due_at            TEXT,
  assigned_user_id  TEXT,
  source_type       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_operator_tasks_lead ON operator_tasks(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_operator_tasks_org ON operator_tasks(org_id, status);

CREATE TABLE IF NOT EXISTS meeting_intelligence (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  transcript_id     TEXT REFERENCES audio_transcripts(id),
  audio_asset_id    TEXT REFERENCES audio_assets(id),
  operator_lead_id  TEXT REFERENCES operator_leads(id),
  meeting_type      TEXT NOT NULL,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL,
  summary           TEXT NOT NULL,
  extraction        TEXT NOT NULL,
  engine            TEXT NOT NULL,
  consent_record_id TEXT,
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  committed_at      TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_org ON meeting_intelligence(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meeting_intelligence(operator_lead_id);

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  meeting_id        TEXT NOT NULL REFERENCES meeting_intelligence(id),
  description       TEXT NOT NULL,
  assigned_user_id  TEXT,
  due_at            TEXT,
  source_start_ms   INTEGER,
  source_end_ms     INTEGER,
  confidence        REAL NOT NULL,
  approval_status   TEXT NOT NULL,
  operator_task_id  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON meeting_action_items(meeting_id);

CREATE TABLE IF NOT EXISTS meeting_deal_variables (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  meeting_id      TEXT NOT NULL REFERENCES meeting_intelligence(id),
  variable_type   TEXT NOT NULL,
  value           TEXT NOT NULL,
  extraction_type TEXT NOT NULL,
  source_start_ms INTEGER,
  source_end_ms   INTEGER,
  confidence      REAL NOT NULL,
  approval_status TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deal_vars_meeting ON meeting_deal_variables(meeting_id);

CREATE TABLE IF NOT EXISTS signal_briefs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  brief_type        TEXT NOT NULL,
  title             TEXT NOT NULL,
  script            TEXT NOT NULL,
  items             TEXT NOT NULL,
  status            TEXT NOT NULL,
  audio_asset_id    TEXT,
  voice_ref         TEXT NOT NULL,
  engine            TEXT NOT NULL,
  error_message     TEXT,
  requested_by      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  rendered_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefs_org ON signal_briefs(org_id, created_at);

CREATE TABLE IF NOT EXISTS signal_brief_schedules (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  brief_type          TEXT NOT NULL,
  cadence             TEXT NOT NULL,
  hour_utc            INTEGER NOT NULL,
  timezone            TEXT NOT NULL,
  subscriber_user_id  TEXT NOT NULL,
  enabled             INTEGER NOT NULL,
  last_run_at         TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brief_schedules_org ON signal_brief_schedules(org_id);

CREATE TABLE IF NOT EXISTS audio_agents (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id),
  provider                TEXT NOT NULL,
  provider_agent_id       TEXT,
  name                    TEXT NOT NULL,
  agent_type              TEXT NOT NULL,
  status                  TEXT NOT NULL,
  configuration           TEXT NOT NULL,
  knowledge_base_version  INTEGER NOT NULL,
  disclosure_version      TEXT NOT NULL,
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_agents_org ON audio_agents(org_id);

CREATE TABLE IF NOT EXISTS agent_knowledge_docs (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL REFERENCES audio_agents(id),
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON agent_knowledge_docs(agent_id);

CREATE TABLE IF NOT EXISTS agent_conversations (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES orgs(id),
  agent_id                  TEXT NOT NULL REFERENCES audio_agents(id),
  provider_conversation_id  TEXT,
  user_id                   TEXT,
  guest_contact             TEXT NOT NULL,
  operator_lead_id          TEXT,
  channel                   TEXT NOT NULL,
  status                    TEXT NOT NULL,
  disclosure_version        TEXT NOT NULL,
  disclosure_shown_at       TEXT NOT NULL,
  started_at                TEXT NOT NULL,
  ended_at                  TEXT,
  duration_seconds          INTEGER,
  transcript                TEXT NOT NULL,
  recording_asset_id        TEXT,
  human_transfer_status     TEXT NOT NULL,
  summary                   TEXT NOT NULL,
  classification            TEXT NOT NULL,
  retention_expires_at      TEXT,
  deleted_at                TEXT,
  created_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_org ON agent_conversations(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_provider ON agent_conversations(provider_conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_retention ON agent_conversations(retention_expires_at);

CREATE TABLE IF NOT EXISTS voice_profiles (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  voice_owner_name      TEXT NOT NULL,
  voice_owner_person_id TEXT,
  provider              TEXT NOT NULL,
  provider_voice_id     TEXT NOT NULL,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  verification_status   TEXT NOT NULL,
  consent_record_id     TEXT NOT NULL,
  permitted_uses        TEXT NOT NULL,
  valid_from            TEXT NOT NULL,
  valid_until           TEXT,
  revoked_at            TEXT,
  revoked_by            TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_profiles_org ON voice_profiles(org_id);

CREATE TABLE IF NOT EXISTS dubbing_projects (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id),
  name                    TEXT NOT NULL,
  source_asset_id         TEXT NOT NULL REFERENCES audio_assets(id),
  source_language         TEXT NOT NULL,
  targets                 TEXT NOT NULL,
  status                  TEXT NOT NULL,
  voice_strategy          TEXT NOT NULL,
  transcript_id           TEXT,
  rights_confirmation_id  TEXT NOT NULL,
  human_review_required   INTEGER NOT NULL,
  review_note             TEXT NOT NULL,
  approved_by             TEXT,
  approved_at             TEXT,
  exported_at             TEXT,
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dubbing_org ON dubbing_projects(org_id, created_at);

CREATE TABLE IF NOT EXISTS campaign_audio_projects (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id),
  name                    TEXT NOT NULL,
  template_type           TEXT NOT NULL,
  source_asset_ids        TEXT NOT NULL,
  voice_profile_id        TEXT,
  status                  TEXT NOT NULL,
  usage_context           TEXT NOT NULL,
  rights_basis            TEXT NOT NULL,
  rights_confirmation_id  TEXT,
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_audio_org ON campaign_audio_projects(org_id, created_at);

CREATE TABLE IF NOT EXISTS remix_projects (
  id                          TEXT PRIMARY KEY,
  org_id                      TEXT NOT NULL REFERENCES orgs(id),
  name                        TEXT NOT NULL,
  source_audio_asset_id       TEXT NOT NULL REFERENCES audio_assets(id),
  rights_confirmation_id      TEXT NOT NULL,
  no_imitation_confirmation_id TEXT NOT NULL,
  remix_lane                  TEXT NOT NULL,
  target_use                  TEXT NOT NULL,
  status                      TEXT NOT NULL,
  provider_song_id            TEXT,
  provider_screening          TEXT NOT NULL,
  composition_plan            TEXT,
  human_review_required       INTEGER NOT NULL,
  final_approval_status       TEXT NOT NULL,
  approved_by                 TEXT,
  approved_at                 TEXT,
  created_by                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remix_org ON remix_projects(org_id, created_at);

CREATE TABLE IF NOT EXISTS remix_versions (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  remix_project_id      TEXT NOT NULL REFERENCES remix_projects(id),
  parent_version_id     TEXT,
  version_type          TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  model                 TEXT NOT NULL,
  seed                  TEXT,
  output_asset_id       TEXT REFERENCES audio_assets(id),
  generation_metadata   TEXT NOT NULL,
  review_status         TEXT NOT NULL,
  reviewed_by           TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remix_versions_project ON remix_versions(remix_project_id, created_at);

CREATE TABLE IF NOT EXISTS audio_usage_ledger (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  project_type          TEXT NOT NULL,
  project_id            TEXT,
  provider              TEXT NOT NULL,
  operation             TEXT NOT NULL,
  model                 TEXT NOT NULL,
  unit                  TEXT NOT NULL,
  input_units           REAL NOT NULL,
  output_units          REAL NOT NULL,
  estimated_cost_micros BIGINT NOT NULL,
  final_cost_micros     BIGINT NOT NULL,
  currency              TEXT NOT NULL,
  provider_request_id   TEXT,
  job_id                TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_usage_org ON audio_usage_ledger(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audio_usage_user ON audio_usage_ledger(org_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS audio_budgets (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  scope                 TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  monthly_cap_micros    BIGINT,
  per_job_cap_micros    BIGINT,
  approval_above_micros BIGINT,
  warn_threshold_pct    REAL NOT NULL,
  hard_stop             INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_budgets ON audio_budgets(org_id, scope, scope_id);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  signature_valid   INTEGER NOT NULL,
  org_id            TEXT,
  payload           TEXT NOT NULL,
  status            TEXT NOT NULL,
  attempts          INTEGER NOT NULL,
  received_at       TEXT NOT NULL,
  processed_at      TEXT,
  failure_reason    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_webhook_events ON provider_webhook_events(provider, external_event_id);
CREATE INDEX IF NOT EXISTS idx_provider_webhook_status ON provider_webhook_events(status, received_at);
`,
  },
  {
    id: '0005_song_lab',
    sql: `
-- ===========================================================================
-- Street Banker Song Lab
--
-- Diagnostic, benchmarking and experimentation layer. Two rules are enforced
-- by the shape of this schema rather than by application discipline:
--
--   1. The original recording is never overwritten. Every rendered experiment
--      lands on its own asset, and every accepted experiment becomes a new
--      song_versions row with a parent pointer. Nothing UPDATEs source bytes.
--   2. A benchmark figure is meaningless without its population. Cohorts carry
--      their filter, their sample size and their provenance, and every stored
--      comparison records the sample size it was computed over.
--
-- Tenant-owned tables carry org_id and every repository method filters on it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS song_lab_projects (
  id                            TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES orgs(id),
  artist_id                     TEXT,
  artist_name                   TEXT NOT NULL,
  title                         TEXT NOT NULL,
  genre                         TEXT NOT NULL,
  status                        TEXT NOT NULL,
  source_asset_id               TEXT,
  current_version_id            TEXT,
  selected_benchmark_cohort_id  TEXT,
  rights_confirmation_id        TEXT NOT NULL,
  -- Set by the artist/producer, and authoritative over any detected title.
  title_phrase                  TEXT NOT NULL,
  notes                         TEXT NOT NULL,
  demo                          INTEGER NOT NULL,
  review_completed_at           TEXT,
  created_by                    TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_lab_projects_org ON song_lab_projects(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_song_lab_projects_artist ON song_lab_projects(org_id, artist_id);

-- Version lineage. parent_version_id is what makes "compare A to B" and
-- "where did this come from" answerable years later.
CREATE TABLE IF NOT EXISTS song_versions (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id TEXT NOT NULL REFERENCES song_lab_projects(id),
  parent_version_id   TEXT,
  version_type        TEXT NOT NULL,
  version_label       TEXT NOT NULL,
  source_asset_id     TEXT,
  experiment_id       TEXT,
  notes               TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_versions_project ON song_versions(org_id, song_lab_project_id, created_at);

-- One row per analysis run. Old runs are never deleted: REANALYZE WITH CURRENT
-- ENGINE adds a row so results stay comparable across engine versions.
CREATE TABLE IF NOT EXISTS song_analyses (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id TEXT NOT NULL REFERENCES song_lab_projects(id),
  song_version_id     TEXT NOT NULL,
  analysis_version    TEXT NOT NULL,
  engine_version      TEXT NOT NULL,
  status              TEXT NOT NULL,
  duration_ms         INTEGER,
  bpm                 REAL,
  bpm_confidence      REAL,
  tempo_stability     REAL,
  song_key            TEXT,
  key_confidence      REAL,
  meter               INTEGER,
  meter_confidence    REAL,
  loudness            REAL,
  dynamic_range       REAL,
  peak_dbfs           REAL,
  stereo_width        REAL,
  first_vocal_ms      INTEGER,
  structure_confidence REAL,
  -- JSON: the full SongFeatureVector, the energy curve, provider provenance,
  -- and the raw provider payloads for Producer View.
  feature_vector      TEXT NOT NULL,
  energy_curve        TEXT NOT NULL,
  vocal_analysis      TEXT NOT NULL,
  providers           TEXT NOT NULL,
  configuration       TEXT NOT NULL,
  source_checksum     TEXT NOT NULL,
  failure_reason      TEXT,
  created_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_song_analyses_project ON song_analyses(org_id, song_lab_project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_song_analyses_version ON song_analyses(song_version_id, created_at);

-- Machine-detected and human-confirmed structure live in the same table.
-- human_confirmed marks a boundary the user owns; reanalysis must preserve it.
CREATE TABLE IF NOT EXISTS song_sections (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  song_analysis_id  TEXT NOT NULL REFERENCES song_analyses(id),
  section_type      TEXT NOT NULL,
  label             TEXT NOT NULL,
  start_ms          INTEGER NOT NULL,
  end_ms            INTEGER NOT NULL,
  confidence        REAL NOT NULL,
  human_confirmed   INTEGER NOT NULL,
  is_hook           INTEGER NOT NULL,
  is_title_phrase   INTEGER NOT NULL,
  order_index       INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_sections_analysis ON song_sections(song_analysis_id, order_index);

CREATE TABLE IF NOT EXISTS song_section_features (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  song_section_id     TEXT NOT NULL REFERENCES song_sections(id),
  energy              REAL NOT NULL,
  vocal_occupancy     REAL,
  syllable_density    REAL,
  arrangement_density REAL NOT NULL,
  spectral_density    REAL NOT NULL,
  transient_density   REAL NOT NULL,
  low_frequency_density REAL NOT NULL,
  stereo_width        REAL,
  rhythmic_density    REAL NOT NULL,
  similarity_vector   TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_song_section_features ON song_section_features(song_section_id);

-- Lyrics are stored per version, not per analysis: an edited lyric belongs to
-- the song, and survives reanalysis.
CREATE TABLE IF NOT EXISTS song_lyric_lines (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  song_version_id TEXT NOT NULL,
  section_id      TEXT,
  line_index      INTEGER NOT NULL,
  start_ms        INTEGER,
  end_ms          INTEGER,
  text            TEXT NOT NULL,
  syllable_count  INTEGER NOT NULL,
  title_phrase    INTEGER NOT NULL,
  hook_phrase     INTEGER NOT NULL,
  user_confirmed  INTEGER NOT NULL,
  lyric_source    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_lyric_lines_version ON song_lyric_lines(org_id, song_version_id, line_index);

-- org_id is NULL for cohorts published by the deployment to every tenant.
-- proprietary cohorts require an explicit entitlement to read.
CREATE TABLE IF NOT EXISTS benchmark_cohorts (
  id                TEXT PRIMARY KEY,
  org_id            TEXT,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  cohort_type       TEXT NOT NULL,
  filter_definition TEXT NOT NULL,
  source_definition TEXT NOT NULL,
  sample_size       INTEGER NOT NULL,
  status            TEXT NOT NULL,
  proprietary       INTEGER NOT NULL,
  provider_id       TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_cohorts_org ON benchmark_cohorts(org_id, status);

-- Derived features only. There is deliberately no column for audio bytes or a
-- storage key here: the benchmark library holds metadata and measurements, not
-- other people's masters.
CREATE TABLE IF NOT EXISTS benchmark_song_features (
  id                  TEXT PRIMARY KEY,
  benchmark_cohort_id TEXT NOT NULL REFERENCES benchmark_cohorts(id),
  benchmark_song_id   TEXT NOT NULL,
  provenance_id       TEXT NOT NULL,
  feature_vector      TEXT NOT NULL,
  metadata            TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_song_features ON benchmark_song_features(benchmark_cohort_id);

CREATE TABLE IF NOT EXISTS benchmark_provenance (
  id                  TEXT PRIMARY KEY,
  benchmark_cohort_id TEXT NOT NULL REFERENCES benchmark_cohorts(id),
  source_kind         TEXT NOT NULL,
  source_name         TEXT NOT NULL,
  basis               TEXT NOT NULL,
  captured_at         TEXT NOT NULL,
  stores_masters      INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_provenance ON benchmark_provenance(benchmark_cohort_id);

CREATE TABLE IF NOT EXISTS song_benchmark_results (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  song_analysis_id      TEXT NOT NULL REFERENCES song_analyses(id),
  benchmark_cohort_id   TEXT NOT NULL,
  metric_key            TEXT NOT NULL,
  song_value            REAL,
  percentile            REAL,
  cohort_median         REAL,
  cohort_mean           REAL,
  p10                   REAL,
  p25                   REAL,
  p75                   REAL,
  p90                   REAL,
  z_score               REAL,
  sample_size           INTEGER NOT NULL,
  confidence            REAL NOT NULL,
  classification        TEXT NOT NULL,
  classification_label  TEXT NOT NULL,
  summary               TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_benchmark_results ON song_benchmark_results(song_analysis_id, benchmark_cohort_id);

CREATE TABLE IF NOT EXISTS song_observations (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id   TEXT NOT NULL REFERENCES song_lab_projects(id),
  song_version_id       TEXT NOT NULL,
  song_analysis_id      TEXT NOT NULL,
  benchmark_cohort_id   TEXT,
  observation_type      TEXT NOT NULL,
  category              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  severity              TEXT NOT NULL,
  confidence            REAL NOT NULL,
  source_metric_keys    TEXT NOT NULL,
  benchmark_result_ids  TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_observations_project ON song_observations(org_id, song_lab_project_id, created_at);

CREATE TABLE IF NOT EXISTS song_recommendations (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  song_observation_id   TEXT NOT NULL REFERENCES song_observations(id),
  recommendation_type   TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  experiment_supported  INTEGER NOT NULL,
  confidence            REAL NOT NULL,
  -- A recommendation is a suggestion until a human says otherwise.
  human_approved        INTEGER NOT NULL,
  approved_by           TEXT,
  approved_at           TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_recommendations ON song_recommendations(song_observation_id);

CREATE TABLE IF NOT EXISTS song_experiments (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id   TEXT NOT NULL REFERENCES song_lab_projects(id),
  source_version_id     TEXT NOT NULL,
  recommendation_id     TEXT,
  name                  TEXT NOT NULL,
  experiment_type       TEXT NOT NULL,
  intent                TEXT NOT NULL,
  edit_decision_list    TEXT NOT NULL,
  bpm_override          REAL,
  status                TEXT NOT NULL,
  preview_asset_id      TEXT,
  predicted_duration_ms INTEGER,
  rendered_duration_ms  INTEGER,
  renderer              TEXT,
  renderer_version      TEXT,
  placeholder_preview   INTEGER NOT NULL,
  accepted_version_id   TEXT,
  failure_reason        TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_experiments_project ON song_experiments(org_id, song_lab_project_id, created_at);

-- Internal A&R. Ratings are traceable: every one names the evidence it rests
-- on, and reviewed_by is never a machine.
CREATE TABLE IF NOT EXISTS song_ar_reviews (
  id                            TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id           TEXT NOT NULL REFERENCES song_lab_projects(id),
  song_analysis_id              TEXT,
  structure_rating              TEXT NOT NULL,
  hook_rating                   TEXT NOT NULL,
  early_payoff_rating           TEXT NOT NULL,
  arrangement_contrast_rating   TEXT NOT NULL,
  vocal_memorability_rating     TEXT NOT NULL,
  streaming_fit_rating          TEXT NOT NULL,
  live_potential_rating         TEXT NOT NULL,
  sync_potential_rating         TEXT NOT NULL,
  recommendation                TEXT NOT NULL,
  why                           TEXT NOT NULL,
  evidence                      TEXT NOT NULL,
  confidence                    REAL NOT NULL,
  status                        TEXT NOT NULL,
  reviewed_by                   TEXT,
  reviewed_at                   TEXT,
  created_by                    TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_ar_reviews ON song_ar_reviews(org_id, song_lab_project_id, created_at);

-- The closed loop. Correlation only: outcome_metrics is observed data, and
-- nothing in this schema records a causal claim.
CREATE TABLE IF NOT EXISTS song_outcome_links (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id     TEXT NOT NULL REFERENCES song_lab_projects(id),
  recommendation_id       TEXT,
  observation_id          TEXT,
  suggested_at            TEXT NOT NULL,
  accepted                INTEGER NOT NULL,
  accepted_at             TEXT,
  implemented             INTEGER NOT NULL,
  implemented_version_id  TEXT,
  release_id              TEXT,
  released_at             TEXT,
  outcome_window          TEXT NOT NULL,
  outcome_metrics         TEXT NOT NULL,
  correlation_notes       TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_outcome_links ON song_outcome_links(org_id, song_lab_project_id);

-- Handoffs to Remix Lab, Live Lab, Release Command Center and Operator Desk.
-- The payload is snapshotted so a downstream module reads what was approved,
-- not whatever the project has become since.
CREATE TABLE IF NOT EXISTS song_lab_handoffs (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id TEXT NOT NULL REFERENCES song_lab_projects(id),
  song_version_id     TEXT NOT NULL,
  target              TEXT NOT NULL,
  target_record_id    TEXT,
  status              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  failure_reason      TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_lab_handoffs ON song_lab_handoffs(org_id, song_lab_project_id, created_at);
`,
  },
  {
    id: '0006_song_lab_vocal_stems',
    sql: `
-- ===========================================================================
-- Isolated vocal stems for Song Lab
--
-- Vocal metrics (occupancy, time to first vocal, phrase length, rest ratio,
-- held notes) are measured from a spectral proxy over the full mix unless an
-- isolated vocal exists. The proxy is honest but capped: a dense guitar record
-- scores as vocal. Separating the stem raises the measurement quality, so the
-- confidence attached to those metrics may rise with it.
--
-- That uplift is only defensible if the stem is real, so this table records
-- the provenance of every stem rather than just pointing at an asset. An
-- analysis that claims an isolated-stem measurement can be traced back to
-- provider and model that produced the audio it measured.
--
-- The stem is a derived asset. The original recording is untouched, as
-- everywhere else in Song Lab.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS song_vocal_stems (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  song_lab_project_id TEXT NOT NULL REFERENCES song_lab_projects(id),
  song_version_id     TEXT NOT NULL,
  -- The mix this was separated from. Pinned so a stem is never silently
  -- reused against a different recording.
  source_asset_id     TEXT NOT NULL,
  source_checksum     TEXT NOT NULL,
  -- The derived audio. NULL until the job completes.
  stem_asset_id       TEXT,
  -- pending | ready | failed | unsupported
  status              TEXT NOT NULL,
  -- The stem name the provider returned (vocals, lead_vocal, ...), kept
  -- verbatim so a provider that renames its outputs is visible in the data.
  stem_name           TEXT,
  provider            TEXT NOT NULL,
  model_version       TEXT NOT NULL,
  failure_reason      TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_vocal_stems_version ON song_vocal_stems(org_id, song_version_id, created_at);
CREATE INDEX IF NOT EXISTS idx_song_vocal_stems_project ON song_vocal_stems(org_id, song_lab_project_id, created_at);
`,
  },
  {
    // Melodic and register analysis. Added rather than folded into 0005 so a
    // deployment that already ran 0005 picks the columns up: forward-only
    // migrations are recorded by id and never re-run.
    //
    // Every column is nullable. A section with no detectable lead vocal, an
    // instrumental, or a row written before this migration all read as "not
    // measured", which is the honest answer and the one the UI already knows
    // how to render.
    id: '0007_song_lab_register',
    sql: `
ALTER TABLE song_section_features ADD COLUMN register_median REAL;
ALTER TABLE song_section_features ADD COLUMN register_low REAL;
ALTER TABLE song_section_features ADD COLUMN register_high REAL;
ALTER TABLE song_section_features ADD COLUMN register_confidence REAL;
ALTER TABLE song_section_features ADD COLUMN melodic_contour TEXT;
`,
  },
]
