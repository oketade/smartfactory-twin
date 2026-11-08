-- =====================================================================================
-- SmartFactory Twin 2.0 — Supabase schema
-- Run once in Supabase → SQL Editor (it is safe to re-run: functions are replaced).
--
-- Security model
--   * Players sign in with Supabase ANONYMOUS auth (no accounts, no e-mails).
--   * Row-level security lets a user READ only the competitions they host or joined.
--   * Nobody can INSERT/UPDATE/DELETE tables directly. Every change goes through the
--     SECURITY DEFINER functions below, which check who is calling and validate input.
--   * Scores are calculated here (sf_score), never trusted from the browser.
--   * Result validation is a PLAUSIBILITY check (time window, value ranges, one final
--     result per player, values never go backwards). It does not replay the simulation,
--     so a determined student with developer tools could still submit an inflated but
--     plausible result. That is a deliberate trade-off for a classroom game.
-- =====================================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables
create table if not exists public.competitions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  host_id     uuid not null,
  mode        text not null default 'individual' check (mode in ('individual', 'team')),
  team_size   int  not null default 4 check (team_size between 2 and 8),
  status      text not null default 'lobby' check (status in ('lobby', 'running', 'finished', 'revealed')),
  seed        bigint,
  started_at  timestamptz,
  ends_at     timestamptz,
  ended_at    timestamptz,
  revealed_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.teams (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  name           text not null,
  color          text not null,
  sort           int  not null
);

create table if not exists public.players (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id        uuid not null,
  name           text not null check (char_length(name) between 2 and 24),
  team_id        uuid references public.teams(id) on delete set null,
  joined_at      timestamptz not null default now(),
  unique (competition_id, user_id)
);
create unique index if not exists players_name_per_competition on public.players (competition_id, lower(name));

create table if not exists public.results (
  player_id      uuid primary key references public.players(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  output         int not null,
  breakdowns     int not null,
  missions       int not null,
  bonus          int not null default 0,
  score          int not null,
  final          boolean not null default false,
  updated_at     timestamptz not null default now()
);
create index if not exists results_competition on public.results (competition_id);
alter table public.results add column if not exists bonus int not null default 0;  -- level bonus (added after 2.0)

create table if not exists public.host_events (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  kind           text not null check (kind in ('break', 'fault')),
  machine        int  not null check (machine between 0 and 2),
  at_s           numeric(6,1) not null,          -- shift time at which every client applies it
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- row-level security
alter table public.competitions enable row level security;
alter table public.teams        enable row level security;
alter table public.players      enable row level security;
alter table public.results      enable row level security;
alter table public.host_events  enable row level security;

create or replace function public.sf_is_member(p_comp uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from competitions c where c.id = p_comp and c.host_id = auth.uid())
      or exists (select 1 from players p where p.competition_id = p_comp and p.user_id = auth.uid());
$$;

drop policy if exists "members read" on public.competitions;
drop policy if exists "members read" on public.teams;
drop policy if exists "members read" on public.players;
drop policy if exists "members read" on public.results;
drop policy if exists "members read" on public.host_events;
create policy "members read" on public.competitions for select to authenticated using (public.sf_is_member(id));
create policy "members read" on public.teams        for select to authenticated using (public.sf_is_member(competition_id));
create policy "members read" on public.players      for select to authenticated using (public.sf_is_member(competition_id));
create policy "members read" on public.results      for select to authenticated using (public.sf_is_member(competition_id));
create policy "members read" on public.host_events  for select to authenticated using (public.sf_is_member(competition_id));

-- belt and braces: no direct writes from the browser roles
revoke insert, update, delete on public.competitions, public.teams, public.players, public.results, public.host_events from anon, authenticated;
revoke all on public.competitions, public.teams, public.players, public.results, public.host_events from anon;
grant select on public.competitions, public.teams, public.players, public.results, public.host_events to authenticated;

-- ---------------------------------------------------------------- realtime
do $$
declare t text;
begin
  foreach t in array array['competitions', 'teams', 'players', 'results', 'host_events'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- helpers (not callable from the browser)
-- Must match js/sim.js scoreOf(): output + level bonus + 150 per mission − 200 per breakdown
drop function if exists public.sf_score(int, int, int);
create or replace function public.sf_score(p_output int, p_bonus int, p_missions int, p_breakdowns int) returns int
language sql immutable as $$ select p_output + p_bonus + 150 * p_missions - 200 * p_breakdowns $$;
-- Must match js/sim.js BONUS: extra share of output per missions completed (0..4)
create or replace function public.sf_bonus_rate(p_missions int) returns numeric
language sql immutable as $$ select (array[0, 0.10, 0.20, 0.35, 0.50])[least(greatest(p_missions, 0), 4) + 1] $$;

create or replace function public.sf_require_user() returns uuid
language plpgsql stable as $$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  return auth.uid();
end $$;

create or replace function public.sf_host_comp(p_code text) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare c competitions;
begin
  perform sf_require_user();
  select * into c from competitions where code = upper(p_code) for update;
  if not found then raise exception 'No competition with that code.'; end if;
  if c.host_id is distinct from auth.uid() then raise exception 'Only the host can do this.'; end if;
  return c;
end $$;

-- shuffle players round-robin into ceil(n / size) teams (max 8)
create or replace function public.sf_do_assign(p_comp uuid, p_size int) returns void
language plpgsql security definer set search_path = public as $$
declare
  n int; k int;
  names  text[] := array['Turbine','Piston','Dynamo','Gearbox','Valve','Rotor','Boiler','Circuit'];
  colors text[] := array['#2fd3f5','#f2b632','#3ccf7a','#ff7a59','#b48cff','#ff5a9e','#7ad7c4','#e3e36a'];
begin
  delete from teams where competition_id = p_comp;
  select count(*) into n from players where competition_id = p_comp;
  k := greatest(1, least(8, ceil(n::numeric / greatest(2, p_size))::int));
  for i in 1..k loop
    insert into teams (competition_id, name, color, sort) values (p_comp, 'Team ' || names[i], colors[i], i);
  end loop;
  with t  as (select id, (row_number() over (order by sort) - 1) as idx from teams where competition_id = p_comp),
       pl as (select id, (row_number() over (order by random()) - 1) % k as idx from players where competition_id = p_comp)
  update players set team_id = t.id from pl join t on t.idx = pl.idx where players.id = pl.id;
end $$;

-- ---------------------------------------------------------------- public API (RPC)
create or replace function public.sf_server_time() returns timestamptz
language sql volatile as $$ select clock_timestamp() $$;

create or replace function public.sf_create_competition(p_mode text, p_team_size int default 4) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare v_code text; v_row competitions; chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  perform sf_require_user();
  if (select count(*) from competitions where host_id = auth.uid() and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many competitions created. Try again later.';
  end if;
  loop
    v_code := '';
    for i in 1..6 loop v_code := v_code || substr(chars, 1 + floor(random() * 32)::int, 1); end loop;
    exit when not exists (select 1 from competitions where code = v_code);
  end loop;
  insert into competitions (code, host_id, mode, team_size)
  values (v_code, auth.uid(), case when p_mode = 'team' then 'team' else 'individual' end, greatest(2, least(8, coalesce(p_team_size, 4))))
  returning * into v_row;
  return v_row;
end $$;

-- minimal public info so the join screen can check a code before registering
create or replace function public.sf_get_competition(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('code', c.code, 'mode', c.mode, 'status', c.status,
         'players', (select count(*) from players p where p.competition_id = c.id))
  from competitions c where c.code = upper(p_code);
$$;

create or replace function public.sf_join(p_code text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare c competitions; p players; v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  perform sf_require_user();
  select * into c from competitions where code = upper(p_code) for update;   -- serialises concurrent joins
  if not found then raise exception 'No competition with that code.'; end if;
  if char_length(v_name) not between 2 and 24 then raise exception 'Enter a name with 2 to 24 characters.'; end if;

  select * into p from players where competition_id = c.id and user_id = auth.uid();
  if found then                                  -- rejoin (reload, reconnect)
    if exists (select 1 from players where competition_id = c.id and lower(name) = lower(v_name) and id <> p.id) then
      raise exception 'That name is already taken in this competition.';
    end if;
    update players set name = v_name where id = p.id returning * into p;
  else
    if c.status <> 'lobby' then raise exception 'This competition has already started.'; end if;
    if (select count(*) from players where competition_id = c.id) >= 30 then raise exception 'This competition is full.'; end if;
    if exists (select 1 from players where competition_id = c.id and lower(name) = lower(v_name)) then
      raise exception 'That name is already taken in this competition.';
    end if;
    insert into players (competition_id, user_id, name) values (c.id, auth.uid(), v_name) returning * into p;
    if c.mode = 'team' and exists (select 1 from teams where competition_id = c.id) then   -- late joiner → smallest team
      update players set team_id = (
        select t.id from teams t left join players x on x.team_id = t.id
        where t.competition_id = c.id group by t.id, t.sort order by count(x.id), t.sort limit 1)
      where id = p.id returning * into p;
    end if;
  end if;
  return json_build_object('comp', to_json(c), 'player', to_json(p));
end $$;

create or replace function public.sf_leave(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform sf_require_user();
  delete from players p using competitions c
  where c.code = upper(p_code) and p.competition_id = c.id and c.status = 'lobby' and p.user_id = auth.uid();
end $$;

create or replace function public.sf_set_mode(p_code text, p_mode text, p_team_size int) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare c competitions;
begin
  c := sf_host_comp(p_code);
  if c.status <> 'lobby' then raise exception 'The mode can only be changed in the lobby.'; end if;
  delete from teams where competition_id = c.id;
  update competitions set mode = case when p_mode = 'team' then 'team' else 'individual' end,
         team_size = greatest(2, least(8, coalesce(p_team_size, 4)))
  where id = c.id returning * into c;
  return c;
end $$;

create or replace function public.sf_assign_teams(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare c competitions;
begin
  c := sf_host_comp(p_code);
  if c.status <> 'lobby' then raise exception 'Teams can only be assigned in the lobby.'; end if;
  perform sf_do_assign(c.id, c.team_size);
  return true;
end $$;

create or replace function public.sf_kick(p_code text, p_player uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare c competitions;
begin
  c := sf_host_comp(p_code);
  delete from players where id = p_player and competition_id = c.id;
  return true;
end $$;

create or replace function public.sf_start(p_code text) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare c competitions; v_start timestamptz := clock_timestamp() + interval '5 seconds';
begin
  c := sf_host_comp(p_code);
  if c.status <> 'lobby' then raise exception 'Already started.'; end if;
  if not exists (select 1 from players where competition_id = c.id) then raise exception 'Nobody has joined yet.'; end if;
  if c.mode = 'team' and (not exists (select 1 from teams where competition_id = c.id)
                          or exists (select 1 from players where competition_id = c.id and team_id is null)) then
    perform sf_do_assign(c.id, c.team_size);
  end if;
  update competitions set status = 'running', seed = floor(random() * 2147483647)::bigint,
         started_at = v_start, ends_at = v_start + interval '360 seconds'
  where id = c.id returning * into c;
  return c;
end $$;

create or replace function public.sf_host_event(p_code text, p_kind text, p_machine int) returns json
language plpgsql security definer set search_path = public as $$
declare c competitions; v_at numeric; v_id uuid;
begin
  c := sf_host_comp(p_code);
  if c.status <> 'running' then raise exception 'The shift is not running.'; end if;
  v_at := round(greatest(0, extract(epoch from clock_timestamp() - c.started_at)) + 3, 1);
  insert into host_events (competition_id, kind, machine, at_s) values (c.id, p_kind, p_machine, v_at) returning id into v_id;
  return json_build_object('id', v_id, 'kind', p_kind, 'machine', p_machine, 'at', v_at);
end $$;

create or replace function public.sf_end(p_code text) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare c competitions;
begin
  c := sf_host_comp(p_code);
  if c.status = 'running' then
    update competitions set status = 'finished', ended_at = least(clock_timestamp(), ends_at) where id = c.id returning * into c;
  end if;
  return c;
end $$;

create or replace function public.sf_reveal(p_code text) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare c competitions;
begin
  c := sf_host_comp(p_code);
  if c.status not in ('finished', 'revealed') then raise exception 'End the competition first.'; end if;
  update competitions set status = 'revealed', revealed_at = clock_timestamp() where id = c.id returning * into c;
  return c;
end $$;

-- The browser sends raw shift statistics; the server validates them and computes the score.
drop function if exists public.sf_submit(text, int, int, int, boolean);
create or replace function public.sf_submit(p_code text, p_output int, p_breakdowns int, p_missions int, p_final boolean, p_bonus int default 0) returns json
language plpgsql security definer set search_path = public as $$
declare c competitions; p players; r results; v_now timestamptz := clock_timestamp(); v_el numeric; v_cap int; v_score int;
begin
  perform sf_require_user();
  select * into c from competitions where code = upper(p_code);
  if not found then raise exception 'No competition with that code.'; end if;
  select * into p from players where competition_id = c.id and user_id = auth.uid();
  if not found then raise exception 'You are not registered in this competition.'; end if;
  if c.status not in ('running', 'finished') then raise exception 'The competition is not running.'; end if;

  v_el := extract(epoch from v_now - c.started_at);
  if v_el < 0 then raise exception 'The shift has not started yet.'; end if;
  if v_now > coalesce(c.ended_at, c.ends_at) + interval '60 seconds' then raise exception 'Submissions for this competition are closed.'; end if;
  if p_final and c.ended_at is null and v_el < 355 then raise exception 'The shift is not over yet.'; end if;

  -- plausibility: 3 machines × 4 units/s × 2.0× max speed = 24 units/s
  v_cap := least(8640, ceil(24 * least(v_el, 360))::int + 50);
  if p_output is null or p_output < 0 or p_output > v_cap then raise exception 'Output is outside the possible range.'; end if;
  if p_missions is null or p_missions < 0 or p_missions > 4 then raise exception 'Mission count is outside the possible range.'; end if;
  if p_breakdowns is null or p_breakdowns < 0 or p_breakdowns > 100 then raise exception 'Breakdown count is outside the possible range.'; end if;
  -- the level bonus can never exceed the bonus rate of the level reached, applied to all output
  if p_bonus is null or p_bonus < 0 or p_bonus > ceil(p_output * sf_bonus_rate(p_missions))::int + 5 then
    raise exception 'Level bonus is outside the possible range.';
  end if;

  select * into r from results where player_id = p.id for update;
  if found then
    if r.final then raise exception 'Your final result is already recorded.'; end if;
    if p_output < r.output or p_bonus < r.bonus or p_missions < r.missions or p_breakdowns < r.breakdowns then
      raise exception 'A result cannot go backwards.';
    end if;
    -- progress reports are throttled to one every 2 s per player
    if not p_final and r.updated_at > v_now - interval '2 seconds' then
      return json_build_object('score', r.score, 'final', false);
    end if;
  end if;

  v_score := sf_score(p_output, p_bonus, p_missions, p_breakdowns);
  insert into results (player_id, competition_id, output, bonus, breakdowns, missions, score, final, updated_at)
  values (p.id, c.id, p_output, p_bonus, p_breakdowns, p_missions, v_score, coalesce(p_final, false), v_now)
  on conflict (player_id) do update set output = excluded.output, bonus = excluded.bonus, breakdowns = excluded.breakdowns, missions = excluded.missions,
     score = excluded.score, final = excluded.final, updated_at = excluded.updated_at;
  return json_build_object('score', v_score, 'final', coalesce(p_final, false));
end $$;

-- Everything a lobby / leaderboard / winner screen needs, ranked on the server.
-- Teams are ranked by AVERAGE member score so uneven team sizes stay fair.
create or replace function public.sf_snapshot(p_code text) returns json
language plpgsql stable security definer set search_path = public as $$
declare c competitions; v json;
begin
  perform sf_require_user();
  select * into c from competitions where code = upper(p_code);
  if not found then raise exception 'No competition with that code.'; end if;
  if not sf_is_member(c.id) then raise exception 'You are not part of this competition.'; end if;

  with pl as (
    select p.id, p.name, p.team_id, false as simulated, (r.player_id is not null) as has_result,
           coalesce(r.final, false) as final, coalesce(r.score, 0) as score, coalesce(r.output, 0) as output, coalesce(r.bonus, 0) as bonus,
           coalesce(r.breakdowns, 0) as breakdowns, coalesce(r.missions, 0) as missions
    from players p left join results r on r.player_id = p.id where p.competition_id = c.id),
  ranked as (select pl.*, rank() over (order by pl.score desc) as "rank" from pl),
  tm as (
    select t.id, t.name, t.color, t.sort, count(pl.id) as "count", coalesce(sum(pl.score), 0)::int as total,
           coalesce(round(avg(pl.score)), 0)::int as "avg"
    from teams t left join pl on pl.team_id = t.id where t.competition_id = c.id group by t.id),
  tr as (select tm.*, rank() over (order by tm."avg" desc) as "rank" from tm)
  select json_build_object(
    'comp',    to_json(c),
    'players', coalesce((select json_agg(ranked order by ranked."rank", ranked.name) from ranked), '[]'::json),
    'teams',   coalesce((select json_agg(tr order by tr."rank", tr.name) from tr), '[]'::json),
    'events',  coalesce((select json_agg(json_build_object('id', e.id, 'kind', e.kind, 'machine', e.machine, 'at', e.at_s) order by e.at_s)
                         from host_events e where e.competition_id = c.id), '[]'::json),
    'server_now', (extract(epoch from clock_timestamp()) * 1000)::bigint)
  into v;
  return v;
end $$;

-- ---------------------------------------------------------------- function permissions
revoke execute on function public.sf_score(int, int, int, int), public.sf_bonus_rate(int) from public, anon, authenticated;
revoke execute on function public.sf_host_comp(text), public.sf_do_assign(uuid, int), public.sf_require_user() from public, anon, authenticated;
revoke execute on function
  public.sf_server_time(), public.sf_create_competition(text, int), public.sf_get_competition(text), public.sf_join(text, text),
  public.sf_leave(text), public.sf_set_mode(text, text, int), public.sf_assign_teams(text), public.sf_kick(text, uuid),
  public.sf_start(text), public.sf_host_event(text, text, int), public.sf_end(text), public.sf_reveal(text),
  public.sf_submit(text, int, int, int, boolean, int), public.sf_snapshot(text)
from public, anon;
grant execute on function
  public.sf_server_time(), public.sf_create_competition(text, int), public.sf_get_competition(text), public.sf_join(text, text),
  public.sf_leave(text), public.sf_set_mode(text, text, int), public.sf_assign_teams(text), public.sf_kick(text, uuid),
  public.sf_start(text), public.sf_host_event(text, text, int), public.sf_end(text), public.sf_reveal(text),
  public.sf_submit(text, int, int, int, boolean, int), public.sf_snapshot(text)
to authenticated;
-- sf_is_member is used inside RLS policies, so authenticated must be able to execute it
grant execute on function public.sf_is_member(uuid) to authenticated;
