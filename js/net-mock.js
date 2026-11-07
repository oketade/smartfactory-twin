/* MOCK backend: a stand-in for Supabase that runs entirely inside this browser.
   - State lives in localStorage, so several tabs on ONE computer can join the same competition
     (each tab is a separate player; identity is per tab via sessionStorage).
   - Tabs are notified of changes through BroadcastChannel and the `storage` event.
   - The "server functions" below run in whichever tab calls them. They apply the same rules as
     the SQL functions, but nothing here is secure: it is for demos and testing only.
   - Simulated players are generated and played by the HOST tab and are always flagged as simulated. */
(function (SF) {
'use strict';
const { rules, sim, bot } = SF;
const PREFIX = 'sf2-mock:';
const SIM_NAMES = ['Nova', 'Atlas', 'Orion', 'Vega', 'Lyra', 'Kestrel', 'Falcon', 'Cobalt', 'Quartz', 'Ember', 'Zephyr', 'Juniper', 'Onyx',
  'Sable', 'Titan', 'Echo', 'Pixel', 'Rook', 'Delta', 'Sierra', 'Tango', 'Ion', 'Flux', 'Halo', 'Comet', 'Argon', 'Basalt', 'Cinder', 'Drift', 'Fjord'];

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
function uid() {
  let u = null;
  try { u = sessionStorage.getItem('sf2-uid'); } catch (e) {}
  if (!u) { u = uuid(); try { sessionStorage.setItem('sf2-uid', u); } catch (e) {} }
  return u;
}
const me = uid();
const chan = 'BroadcastChannel' in window ? new BroadcastChannel('sf2-mock') : null;
const listeners = new Set();
let status = 'connected';
const statusCbs = new Set();

function load(code) { try { return JSON.parse(localStorage.getItem(PREFIX + code) || 'null'); } catch (e) { return null; } }
function save(db) {
  try { localStorage.setItem(PREFIX + db.comp.code, JSON.stringify(db)); }
  catch (e) { throw new Error('This browser blocked local storage, so the mock backend cannot save.'); }
  notify(db.comp.code);
}
function notify(code) { if (chan) chan.postMessage({ code }); listeners.forEach(l => l(code)); }
if (chan) chan.onmessage = e => listeners.forEach(l => l(e.data.code));
window.addEventListener('storage', e => { if (e.key && e.key.startsWith(PREFIX)) listeners.forEach(l => l(e.key.slice(PREFIX.length))); });

const fail = msg => { throw new Error(msg); };
const now = () => Date.now();
function mustLoad(code) { return load(code) || fail('No competition with that code.'); }
function mustHost(db) { if (db.comp.host_id !== me) fail('Only the host can do this.'); }
const delay = v => new Promise(r => setTimeout(() => r(v), 60)); // feels like a network call

// ---------- "server functions"
const api = {
  kind: 'mock',
  // host identity survives closing the tab: saved on create, restored only by "Resume hosting"
  rememberHost() { try { localStorage.setItem('sf2-host-id', me); } catch (e) {} },
  restoreHost() { try { const u = localStorage.getItem('sf2-host-id'); if (u) sessionStorage.setItem('sf2-uid', u); } catch (e) {} },
  me,
  label: 'MOCK BACKEND · this browser only',
  async init() { return true; },
  status: () => status,
  onStatus(cb) { statusCbs.add(cb); cb(status); return () => statusCbs.delete(cb); },
  serverNow: now,

  async createCompetition({ mode, teamSize }) {
    let code; do code = rules.makeCode(); while (load(code));
    const db = {
      comp: { id: code, code, host_id: me, mode: mode === 'team' ? 'team' : 'individual', team_size: teamSize || 4, status: 'lobby',
        seed: null, started_at: null, ends_at: null, ended_at: null, revealed_at: null, created_at: new Date().toISOString() },
      players: {}, teams: {}, results: {}, events: [],
    };
    save(db); return delay(db.comp);
  },

  async getCompetition(code) { const db = load(rules.normCode(code)); return delay(db ? db.comp : null); },

  async joinCompetition(code, name) {
    const db = mustLoad(rules.normCode(code));
    name = rules.cleanName(name);
    const err = rules.validName(name); if (err) fail(err);
    const mine = Object.values(db.players).find(p => p.user_id === me);
    if (mine) { mine.name = name; mine.last_seen = now(); save(db); return delay({ comp: db.comp, player: mine }); }
    if (db.comp.status !== 'lobby') fail('This competition has already started.');
    if (Object.keys(db.players).length >= rules.RULES.MAX_PLAYERS) fail('This competition is full.');
    if (Object.values(db.players).some(p => p.name.toLowerCase() === name.toLowerCase())) fail('That name is already taken in this competition.');
    const p = { id: uuid(), user_id: me, name, team_id: null, simulated: false, last_seen: now(), joined_at: now() };
    db.players[p.id] = p;
    if (db.comp.mode === 'team' && Object.keys(db.teams).length) autoPlace(db, p);
    save(db); return delay({ comp: db.comp, player: p });
  },

  async leaveCompetition(code) {
    const db = load(code); if (!db || db.comp.status !== 'lobby') return;
    Object.values(db.players).forEach(p => { if (p.user_id === me) delete db.players[p.id]; });
    save(db);
  },

  async setMode(code, mode, teamSize) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'lobby') fail('The mode can only be changed in the lobby.');
    db.comp.mode = mode === 'team' ? 'team' : 'individual'; db.comp.team_size = Math.max(2, Math.min(8, teamSize | 0 || 4));
    db.teams = {}; Object.values(db.players).forEach(p => p.team_id = null);
    save(db); return delay(db.comp);
  },

  async assignTeams(code) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'lobby') fail('Teams can only be assigned in the lobby.');
    doAssign(db); save(db); return delay(true);
  },

  async kickPlayer(code, playerId) {
    const db = mustLoad(code); mustHost(db);
    delete db.players[playerId]; delete db.results[playerId]; save(db); return delay(true);
  },

  async startCompetition(code) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'lobby') fail('Already started.');
    if (!Object.keys(db.players).length) fail('Nobody has joined yet.');
    if (db.comp.mode === 'team' && (!Object.keys(db.teams).length || Object.values(db.players).some(p => !p.team_id))) doAssign(db);
    const start = now() + rules.RULES.COUNTDOWN_S * 1000;
    Object.assign(db.comp, { status: 'running', seed: (Math.random() * 2 ** 31) >>> 0,
      started_at: new Date(start).toISOString(), ends_at: new Date(start + sim.SHIFT * 1000).toISOString() });
    save(db); return delay(db.comp);
  },

  async hostEvent(code, kind, machine) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'running') fail('The shift is not running.');
    const at = Math.max(0, (now() - Date.parse(db.comp.started_at)) / 1000) + rules.RULES.HOST_EVENT_LEAD_S;
    const ev = { id: uuid(), kind, machine, at: Math.round(at * 10) / 10 };
    db.events.push(ev); save(db); return delay(ev);
  },

  async endCompetition(code) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status === 'running') { db.comp.status = 'finished'; db.comp.ended_at = new Date(Math.min(now(), Date.parse(db.comp.ends_at))).toISOString(); save(db); }
    return delay(db.comp);
  },

  async revealWinners(code) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'finished' && db.comp.status !== 'revealed') fail('End the competition first.');
    db.comp.status = 'revealed'; db.comp.revealed_at = new Date().toISOString(); save(db); return delay(db.comp);
  },

  // the server computes the score; the client only sends raw shift statistics
  async submitResult(code, playerId, stats, final) {
    const db = mustLoad(code);
    const p = db.players[playerId] || fail('Unknown player.');
    if (p.user_id !== me && !(p.simulated && db.comp.host_id === me)) fail('You can only submit your own result.');
    applyResult(db, p, stats, final);
    save(db); return delay({ score: db.results[p.id].score, final: db.results[p.id].final });
  },

  async heartbeat(code, playerId) {
    const db = load(code); if (!db || !db.players[playerId]) return;
    db.players[playerId].last_seen = now(); save(db);
  },

  events(code) { const db = load(code); return db ? db.events : []; },

  watch(code, cb) {
    let t = null;
    const fire = () => { t = null; const db = load(code); if (db) cb(rules.snapshot(db, now())); };
    const l = c => { if (c === code && !t) t = setTimeout(fire, 30); };
    listeners.add(l); fire();
    return () => listeners.delete(l);
  },

  // ---------- mock-only helpers (host)
  supportsSimulated: true,
  async addSimulated(code, n) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'lobby') fail('Simulated players can only be added in the lobby.');
    const used = new Set(Object.values(db.players).map(p => p.name.toLowerCase()));
    let added = 0;
    for (const base of SIM_NAMES) {
      if (added >= n || Object.keys(db.players).length >= rules.RULES.MAX_PLAYERS) break;
      const name = 'SIM ' + base; if (used.has(name.toLowerCase())) continue;
      const p = { id: uuid(), user_id: me, name, team_id: null, simulated: true, skill: Math.round(Math.random() * 100) / 100,
        bot_seed: (Math.random() * 2 ** 31) >>> 0, last_seen: now(), joined_at: now() };
      db.players[p.id] = p; used.add(name.toLowerCase()); added++;
      if (db.comp.mode === 'team' && Object.keys(db.teams).length) autoPlace(db, p);
    }
    save(db); return delay(added);
  },
  async removeSimulated(code) {
    const db = mustLoad(code); mustHost(db);
    if (db.comp.status !== 'lobby') fail('Only in the lobby.');
    Object.values(db.players).forEach(p => { if (p.simulated) delete db.players[p.id]; });
    save(db); return delay(true);
  },
  simulatedPlayers(code) { const db = load(code); return db ? Object.values(db.players).filter(p => p.simulated) : []; },
  // batch update for the host's bots (one storage write instead of 25)
  async submitSimulated(code, list, final) {
    const db = load(code); if (!db || db.comp.host_id !== me) return;
    list.forEach(({ id, stats }) => { const p = db.players[id]; if (p && p.simulated) { try { applyResult(db, p, stats, final); } catch (e) {} } });
    save(db);
  },
};

function applyResult(db, p, stats, final) {
  const prev = db.results[p.id];
  if (prev && prev.final) fail('Your final result is already recorded.');
  const err = rules.validateStats(db.comp, stats, final, now()); if (err) fail(err);
  if (prev && (stats.output < prev.output || stats.missions < prev.missions || stats.breakdowns < prev.breakdowns)) fail('A result cannot go backwards.');
  const score = sim.scoreOf(stats.output, stats.missions, stats.breakdowns);
  db.results[p.id] = { output: stats.output, breakdowns: stats.breakdowns, missions: stats.missions, score, final: !!final, at: now() };
  p.last_seen = now();
}
function doAssign(db) {
  const teams = rules.assignTeams(Object.keys(db.players), db.comp.team_size);
  db.teams = {}; teams.forEach(t => { db.teams[t.id] = { id: t.id, name: t.name, color: t.color }; t.members.forEach(id => db.players[id].team_id = t.id); });
}
// a late joiner goes to the smallest team
function autoPlace(db, p) {
  const counts = Object.keys(db.teams).map(id => [id, Object.values(db.players).filter(x => x.team_id === id).length]);
  counts.sort((a, b) => a[1] - b[1]); p.team_id = counts[0][0];
}

SF.netMock = api;
})(window.SF = window.SF || {});
