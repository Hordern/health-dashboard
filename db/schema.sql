-- Health dashboard schema. Safe to re-run: every statement is idempotent.

-- Small key/value store for OAuth tokens, coach instructions and similar.
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Garmin activities (runs, strength, walks, ...).
create table if not exists activities (
  id                    bigint primary key,
  date                  date not null,
  start_local           timestamp not null,
  type                  text not null,
  name                  text,
  distance_km           numeric(7, 2),
  duration_s            numeric(9, 1),
  avg_hr                integer,
  max_hr                integer,
  elevation_gain_m      numeric(7, 1),
  training_effect_label text,
  raw                   jsonb not null
);
create index if not exists activities_date_idx on activities (date);

-- One row per day of Garmin recovery data. Raw payloads are kept so new
-- fields can be promoted to columns later without re-fetching.
create table if not exists health_daily (
  date            date primary key,
  resting_hr      integer,
  hrv_last_night  integer,
  hrv_status      text,
  readiness_score integer,
  readiness_level text,
  acute_load      integer,
  sleep_score     integer,
  sleep_s         integer,
  deep_s          integer,
  light_s         integer,
  rem_s           integer,
  awake_s         integer,
  raw             jsonb not null
);

-- Withings weigh-ins.
create table if not exists weights (
  measured_at timestamptz primary key,
  weight_kg   numeric(5, 2) not null,
  fat_ratio   numeric(4, 1),
  muscle_kg   numeric(5, 2),
  raw         jsonb not null
);

-- JEFIT workout sessions with their logged sets.
create table if not exists gym_sessions (
  id        text primary key,
  date      date not null,
  name      text,
  exercises jsonb not null,
  raw       jsonb not null
);
create index if not exists gym_sessions_date_idx on gym_sessions (date);

-- The running plan, imported from CURRENT_PLAN.md.
create table if not exists plan_weeks (
  start_date       date primary key,
  end_date         date not null,
  label            text not null,
  planned_total_km numeric(5, 1),
  summary          text
);

create table if not exists plan_days (
  date       date primary key,
  week_start date not null references plan_weeks (start_date) on delete cascade,
  gym        text,
  run_type   text,
  planned_km numeric(5, 1),
  hr_guide   text,
  shoe       text,
  status     text not null,
  notes      text
);

-- The daily Claude coaching write-up.
create table if not exists coaching_notes (
  date       date primary key,
  model      text not null,
  body       text not null,
  created_at timestamptz not null default now()
);

-- One row per source per daily run, so failures are visible on the dashboard.
create table if not exists sync_runs (
  id          serial primary key,
  source      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  message     text
);
