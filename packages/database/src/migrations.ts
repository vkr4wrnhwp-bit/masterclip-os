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
]
