/* REAL backend adapter: Supabase (PostgreSQL + Realtime + anonymous auth).
   Same interface as net-mock.js. The browser never writes tables directly: every change is an
   RPC to a SECURITY DEFINER function in supabase/schema.sql, which validates the request and
   (for results) calculates the score on the server. */
(function (SF) {
'use strict';
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
let sb = null, me = null, offset = 0, status = 'connecting';
const statusCbs = new Set();
function setStatus(s) { if (s !== status) { status = s; statusCbs.forEach(cb => cb(s)); } }

// Auth storage: one identity per tab (sessionStorage), so every tab is its own player.
// A HOST tab also mirrors its login to localStorage, so the host can get back into the
// competition after closing the tab ("Resume hosting" on the home screen). Player tabs
// never read that copy, so opening a new tab still creates a new player.
const HOST_FLAG = 'sf2-hosting', MIRROR = 'sf2-host-auth:';
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
};
const hosting = () => ss.get(HOST_FLAG) === '1';
const authStorage = {
  getItem: k => ss.get(k),
  setItem(k, v) { ss.set(k, v); if (hosting()) try { localStorage.setItem(MIRROR + k, v); } catch (e) {} },
  removeItem(k) { ss.del(k); if (hosting()) try { localStorage.removeItem(MIRROR + k); } catch (e) {} },
};

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('Could not load the Supabase library. Check the internet connection.'));
    document.head.appendChild(s);
  });
}
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) {
    if (/Failed to fetch|NetworkError/i.test(error.message || '')) setStatus('offline');
    throw new Error(error.message || 'Server error');
  }
  if (status === 'offline') setStatus('connected');
  return data;
}

const api = {
  kind: 'supabase',
  get me() { return me; },
  label: 'LIVE · Supabase',
  async init() {
    const cfg = SF.config;
    if (!window.supabase) await loadScript(CDN);
    // sessionStorage: each browser tab gets its own anonymous identity (one tab = one player)
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { storage: authStorage, persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    let { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) throw new Error('Anonymous sign-in failed: ' + error.message + ' (enable it in Supabase → Authentication → Providers).');
      session = data.session;
    }
    me = session.user.id;
    // clock offset so every device agrees on the shift clock
    const t0 = Date.now(); const srv = await rpc('sf_server_time'); const t1 = Date.now();
    offset = Date.parse(srv) - (t0 + t1) / 2;
    setStatus('connected');
    window.addEventListener('offline', () => setStatus('offline'));
    window.addEventListener('online', () => setStatus('connecting'));
    return true;
  },
  status: () => status,
  onStatus(cb) { statusCbs.add(cb); cb(status); return () => statusCbs.delete(cb); },
  serverNow: () => Date.now() + offset,

  // copy this tab's login to localStorage and keep the copy fresh as tokens refresh
  rememberHost() {
    ss.set(HOST_FLAG, '1');
    try {
      Object.keys(localStorage).filter(k => k.startsWith(MIRROR)).forEach(k => localStorage.removeItem(k));
      Object.keys(sessionStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.setItem(MIRROR + k, sessionStorage.getItem(k)));
    } catch (e) {}
  },
  // put the saved host login back into this tab (the caller reloads the page afterwards)
  restoreHost() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith(MIRROR)).forEach(k => ss.set(k.slice(MIRROR.length), localStorage.getItem(k)));
    } catch (e) {}
    ss.set(HOST_FLAG, '1');
  },

  createCompetition: ({ mode, teamSize }) => rpc('sf_create_competition', { p_mode: mode, p_team_size: teamSize || 4 }),
  getCompetition: code => rpc('sf_get_competition', { p_code: code }),
  joinCompetition: (code, name) => rpc('sf_join', { p_code: code, p_name: name }),
  leaveCompetition: code => rpc('sf_leave', { p_code: code }),
  setMode: (code, mode, teamSize) => rpc('sf_set_mode', { p_code: code, p_mode: mode, p_team_size: teamSize }),
  assignTeams: code => rpc('sf_assign_teams', { p_code: code }),
  kickPlayer: (code, playerId) => rpc('sf_kick', { p_code: code, p_player: playerId }),
  startCompetition: code => rpc('sf_start', { p_code: code }),
  hostEvent: (code, kind, machine) => rpc('sf_host_event', { p_code: code, p_kind: kind, p_machine: machine }),
  endCompetition: code => rpc('sf_end', { p_code: code }),
  revealWinners: code => rpc('sf_reveal', { p_code: code }),
  // raw stats only — sf_submit validates them and calculates the score server-side
  submitResult: (code, _playerId, s, final) => rpc('sf_submit', { p_code: code, p_output: s.output, p_breakdowns: s.breakdowns, p_missions: s.missions, p_final: !!final }),
  async heartbeat() {},  // presence on the realtime channel replaces heartbeats

  // live snapshot: Realtime change events trigger a (debounced) re-fetch of sf_snapshot()
  watch(code, cb, opts) {
    opts = opts || {};
    let closed = false, timer = null, last = null, channel = null, online = new Set();
    const debounce = opts.host ? 500 : 1500;
    const emit = () => {
      if (!last) return;
      last.players.forEach(p => { p.online = online.has(p.id); });
      cb(last);
    };
    const fetchNow = async () => {
      timer = null;
      try { last = await rpc('sf_snapshot', { p_code: code }); if (!closed) { emit(); ensureChannel(); } }
      catch (e) { console.warn('[sf] snapshot failed', e); }
    };
    const soon = () => { if (!timer) timer = setTimeout(fetchNow, debounce); };
    function ensureChannel() {
      if (channel || !last) return;
      const id = last.comp.id, f = 'competition_id=eq.' + id;
      channel = sb.channel('sf2:' + id, { config: { presence: { key: opts.playerId || 'host:' + me } } });
      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'competitions', filter: 'id=eq.' + id }, soon)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: f }, soon)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: f }, soon)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'results', filter: f }, soon)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'host_events', filter: f }, () => { clearTimeout(timer); fetchNow(); })
        .on('presence', { event: 'sync' }, () => { online = new Set(Object.keys(channel.presenceState())); emit(); })
        .subscribe(async st => {
          // re-fetch now and once more shortly after: changes made while the channel was still joining are not replayed
          if (st === 'SUBSCRIBED') { setStatus('connected'); await channel.track({ at: Date.now() }); fetchNow(); setTimeout(() => { if (!closed) fetchNow(); }, 3000); }
          else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') setStatus('connecting');
          else if (st === 'CLOSED' && !closed) setStatus('offline');
        });
    }
    fetchNow();
    const poll = setInterval(() => { if (!timer) fetchNow(); }, 15000); // safety net if Realtime drops
    return () => { closed = true; clearInterval(poll); clearTimeout(timer); if (channel) sb.removeChannel(channel); };
  },

  supportsSimulated: false,
};

SF.netSupabase = api;
})(window.SF = window.SF || {});
