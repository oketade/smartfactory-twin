/* Competition rules shared by the MOCK server.
   The real backend enforces the same rules in PostgreSQL (supabase/schema.sql).
   If you change a rule here, change it there too. */
(function (SF) {
'use strict';
const sim = SF.sim;

const RULES = {
  MAX_PLAYERS: 30,
  COUNTDOWN_S: 5,          // start_competition schedules the shift this far in the future
  SUBMIT_GRACE_S: 60,      // results accepted up to this long after the shift ends
  HOST_EVENT_LEAD_S: 3,    // host events land this many shift-seconds after they are sent
  OUTPUT_PER_S_MAX: sim.DEF.length * sim.RATE * 2.0, // 24 units/s at 3 machines × 2.0×
};

const TEAMS = [
  ['Turbine', '#2fd3f5'], ['Piston', '#f2b632'], ['Dynamo', '#3ccf7a'], ['Gearbox', '#ff7a59'],
  ['Valve', '#b48cff'], ['Rotor', '#ff5a9e'], ['Boiler', '#7ad7c4'], ['Circuit', '#e3e36a'],
];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() { let c = ''; for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; }
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim();

function validName(n) {
  n = cleanName(n);
  if (n.length < 2 || n.length > 24) return 'Enter a name with 2 to 24 characters.';
  return null;
}

// returns an error string, or null if the submission is plausible
function validateStats(comp, stats, final, nowMs) {
  if (comp.status !== 'running' && comp.status !== 'finished') return 'The competition is not running.';
  const started = Date.parse(comp.started_at);
  const elapsed = (nowMs - started) / 1000;
  if (elapsed < 0) return 'The shift has not started yet.';
  const closes = Date.parse(comp.ended_at || comp.ends_at) + RULES.SUBMIT_GRACE_S * 1000;
  if (nowMs > closes) return 'Submissions for this competition are closed.';
  if (final && !comp.ended_at && elapsed < sim.SHIFT - 5) return 'The shift is not over yet.';
  const { output, breakdowns, missions } = stats;
  if (![output, breakdowns, missions].every(Number.isInteger)) return 'Malformed result.';
  const cap = Math.min(sim.MAX_OUTPUT, Math.ceil(RULES.OUTPUT_PER_S_MAX * Math.min(elapsed, sim.SHIFT)) + 50);
  if (output < 0 || output > cap) return 'Output is outside the possible range.';
  if (missions < 0 || missions > sim.MISSIONS.length) return 'Mission count is outside the possible range.';
  if (breakdowns < 0 || breakdowns > 100) return 'Breakdown count is outside the possible range.';
  // the level bonus can never exceed the bonus rate of the level reached, applied to all output
  const bonus = stats.bonus == null ? 0 : stats.bonus;
  if (!Number.isInteger(bonus) || bonus < 0 || bonus > Math.ceil(output * sim.BONUS[missions]) + 5) return 'Level bonus is outside the possible range.';
  return null;
}

// round-robin into ceil(n / size) teams after a shuffle
function assignTeams(playerIds, size) {
  const ids = [...playerIds];
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const n = Math.max(1, Math.min(TEAMS.length, Math.ceil(ids.length / Math.max(2, size))));
  const teams = TEAMS.slice(0, n).map(([name, color], i) => ({ id: 't' + (i + 1), name: 'Team ' + name, color, members: [] }));
  ids.forEach((id, i) => teams[i % n].members.push(id));
  return teams;
}

// rank with ties sharing a place (1, 2, 2, 4)
function rankBy(list, key) {
  list.sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name));
  list.forEach((x, i) => { x.rank = i > 0 && list[i - 1][key] === x[key] ? list[i - 1].rank : i + 1; });
  return list;
}

// Snapshot shape returned by both backends (mock: here; Supabase: sf_snapshot()).
function snapshot(db, nowMs) {
  const c = db.comp;
  const players = Object.values(db.players).map(p => {
    const r = db.results[p.id];
    return { id: p.id, name: p.name, team_id: p.team_id || null, simulated: !!p.simulated,
      online: !!p.simulated || nowMs - (p.last_seen || 0) < 12000,
      has_result: !!r, final: !!(r && r.final), score: r ? r.score : 0, output: r ? r.output : 0, bonus: r ? r.bonus || 0 : 0,
      breakdowns: r ? r.breakdowns : 0, missions: r ? r.missions : 0 };
  });
  rankBy(players, 'score');
  const teams = Object.values(db.teams).map(t => {
    const ms = players.filter(p => p.team_id === t.id);
    const total = ms.reduce((s, p) => s + p.score, 0);
    return { id: t.id, name: t.name, color: t.color, count: ms.length, total, avg: ms.length ? Math.round(total / ms.length) : 0 };
  });
  rankBy(teams, 'avg');
  return { comp: { ...c }, players, teams, events: db.events || [], server_now: nowMs };
}

SF.rules = { RULES, TEAMS, makeCode, normCode, cleanName, validName, validateStats, assignTeams, snapshot };
})(window.SF = window.SF || {});
