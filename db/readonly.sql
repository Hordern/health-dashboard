-- Read-only login for the Claude connector's sql_query tool.
-- SELECT on the data tables only: `settings` (OAuth/session tokens) and
-- `sync_runs` are deliberately left out. The password is set by migrate.js
-- from READONLY_DB_PASSWORD, so it never lives in this file.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dashboard_reader') then
    create role dashboard_reader login;
  end if;
end
$$;

grant usage on schema public to dashboard_reader;
grant select on activities, health_daily, weights, gym_sessions, plan_weeks, plan_days, coaching_notes to dashboard_reader;
revoke all on settings, sync_runs from dashboard_reader;
alter role dashboard_reader set statement_timeout = '5s';
alter role dashboard_reader set default_transaction_read_only = on;
