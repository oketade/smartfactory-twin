/* App controller: backend selection, screens, registration, lobby, host console,
   simulated players (mock only) and the winner announcement. */
(function (SF) {
'use strict';
const { board, game, sim, rules } = SF;
const $ = id => document.getElementById(id);
const cfg = SF.config || {};
const forceMock = /[?&]backend=mock\b/.test(location.search);
const net = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !forceMock ? SF.netSupabase : SF.netMock;
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let session = null;           // { role: 'player'|'host', code, playerId?, name? }
let unwatch = null, snap = null, shownRevealAt = null, hbTimer = null;
const SCREENS = ['scrHome', 'scrLobby', 'scrGame', 'scrHost', 'scrResults'];
function show(id) {
  SCREENS.forEach(s => $(s).hidden = s !== id);
  $('footNote').hidden = id === 'scrResults';
  if (id === 'scrGame') requestAnimationFrame(() => game.render());
}
function err(el, msg) { el.textContent = msg; el.hidden = !msg; }
function saveSession(s) { session = s; try { s ? sessionStorage.setItem('sf2-session', JSON.stringify(s)) : sessionStorage.removeItem('sf2-session'); } catch (e) {} }
function loadSession() { try { return JSON.parse(sessionStorage.getItem('sf2-session') || 'null'); } catch (e) { return null; } }
function setWho(txt) { $('opName').textContent = txt || 'Not registered'; }
function stopWatching() { if (unwatch) unwatch(); unwatch = null; snap = null; clearInterval(hbTimer); hbTimer = null; stopBots(); }
function goHome(msg) {
  if (session && session.role === 'host') setHostLast(null);   // host left on purpose: nothing to resume
  stopWatching(); game.stop(); saveSession(null); shownRevealAt = null;
  show('scrHome'); setWho(''); if (msg) err($('jErr'), msg);
  showResume();
}

// ---------- resume hosting after the host's tab was closed
const HOST_LAST = 'sf2-host-last', RESUME_MAX_MS = 12 * 3600 * 1000;
function setHostLast(code) { try { code ? localStorage.setItem(HOST_LAST, JSON.stringify({ code, at: Date.now() })) : localStorage.removeItem(HOST_LAST); } catch (e) {} }
function getHostLast() {
  try { const h = JSON.parse(localStorage.getItem(HOST_LAST) || 'null'); return h && Date.now() - h.at < RESUME_MAX_MS ? h : null; } catch (e) { return null; }
}
function showResume() {
  const h = !session && getHostLast(), b = $('hResume');
  b.hidden = !h; if (h) b.textContent = `Resume hosting ${h.code}`;
}

// ---------- backend + connection chips
function initChips() {
  const chip = $('backendChip');
  if (net.kind === 'mock') { chip.textContent = 'MOCK BACKEND · SIMULATED DATA · THIS BROWSER ONLY'; chip.className = 'sim'; chip.title = 'No real network: other players are tabs on this computer or simulated players.'; }
  else { chip.textContent = 'LIVE · SUPABASE'; chip.className = 'sim live'; }
  net.onStatus(s => {
    const c = $('connChip'); c.dataset.s = s;
    c.lastChild.textContent = s === 'connected' ? (net.kind === 'mock' ? 'Local mock · ready' : 'Connected') : s === 'offline' ? 'Offline · reconnecting' : 'Connecting…';
  });
}

// ---------- home forms
function bindHome() {
  const m = /[?&]join=([A-Za-z0-9]+)/.exec(location.search);
  if (m) { $('jCode').value = rules.normCode(m[1]); }
  $('jCode').addEventListener('input', e => { e.target.value = rules.normCode(e.target.value).slice(0, 6); });
  $('joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = rules.cleanName($('jName').value), code = rules.normCode($('jCode').value);
    const ne = rules.validName(name); if (ne) { err($('jErr'), ne); $('jName').focus(); return; }
    if (code.length !== 6) { err($('jErr'), 'The competition code has 6 characters.'); $('jCode').focus(); return; }
    err($('jErr'), ''); $('jBtn').disabled = true; $('jBtn').textContent = 'Joining…';
    try {
      const r = await net.joinCompetition(code, name);
      saveSession({ role: 'player', code, playerId: r.player.id, name: r.player.name });
      enterPlayer();
    } catch (ex) { err($('jErr'), ex.message); }
    finally { $('jBtn').disabled = false; $('jBtn').textContent = 'Join competition'; }
  });
  const syncTeamOnly = () => { const team = document.querySelector('input[name=hMode]:checked').value === 'team'; document.querySelectorAll('#hostForm .team-only').forEach(el => el.hidden = !team); };
  document.querySelectorAll('input[name=hMode]').forEach(r => r.addEventListener('change', syncTeamOnly)); syncTeamOnly();
  $('hostForm').addEventListener('submit', async e => {
    e.preventDefault();
    const mode = document.querySelector('input[name=hMode]:checked').value;
    try {
      const comp = await net.createCompetition({ mode, teamSize: +$('hSize').value || 4 });
      saveSession({ role: 'host', code: comp.code });
      enterHost();
    } catch (ex) { err($('hErr'), ex.message); }
  });
  $('hResume').addEventListener('click', () => {
    const h = getHostLast(); if (!h) { showResume(); return; }
    net.restoreHost(); saveSession({ role: 'host', code: h.code }); location.reload();
  });
  $('practiceForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('pName').value.trim();
    if (v.length < 2 || v.length > 24) { $('pErr').hidden = false; $('pName').focus(); return; }
    $('pErr').hidden = true; setWho(v); show('scrGame'); game.practice(v);
  });
}

// ---------- player
function enterPlayer() {
  stopWatching();
  setWho(session.name);
  $('lCode').textContent = session.code; $('lName').textContent = session.name;
  show('scrLobby');
  unwatch = net.watch(session.code, onPlayerSnap, { playerId: session.playerId });
  if (net.kind === 'mock') { const beat = () => net.heartbeat(session.code, session.playerId); beat(); hbTimer = setInterval(beat, 4000); }
}
function onPlayerSnap(s) {
  if (!session || session.role !== 'player') return;
  snap = s;
  const me = s.players.find(p => p.id === session.playerId);
  if (!me) { goHome('You are no longer registered in that competition (the host may have removed you).'); return; }
  const team = s.teams.find(t => t.id === me.team_id);
  const st = s.comp.status;
  if (st === 'lobby') {
    show('scrLobby');
    $('lStatus').textContent = 'Waiting for the host to start';
    $('lMode').textContent = s.comp.mode === 'team' ? `Team mode · teams of about ${s.comp.team_size}, assigned automatically` : 'Individual mode · every operator for themselves';
    const lt = $('lTeam'); if (team) { lt.hidden = false; lt.textContent = team.name; lt.style.setProperty('--tc', team.color); } else lt.hidden = true;
    $('lCount').textContent = `${s.players.length} joined`;
    board.roster($('lRoster'), s, { meId: me.id });
    return;
  }
  if (st === 'running' || st === 'finished') {
    if (!game.active) { show('scrGame'); game.competition({ comp: s.comp, player: me, net, team }); }
    else if ($('scrGame').hidden) show('scrGame');
    game.onSnapshot(s);
    return;
  }
  if (st === 'revealed') {
    if (game.active) game.onSnapshot(s);
    if (shownRevealAt !== s.comp.revealed_at) { shownRevealAt = s.comp.revealed_at; $('endOv').hidden = true; show('scrResults'); board.results(s, { meId: me.id }); }
  }
}

// ---------- host
let hView = 'players', endArm = null, autoEnding = false;
function enterHost() {
  stopWatching(); game.stop();
  setWho('Host');
  net.rememberHost(); setHostLast(session.code);
  $('hCode').textContent = session.code;
  const link = location.href.split(/[?#]/)[0] + '?join=' + session.code;
  $('hLink').textContent = 'Students open: ' + link;
  renderJoinQr(link);
  $('simTools').hidden = !net.supportsSimulated; $('simNote').hidden = !net.supportsSimulated;
  show('scrHost');
  unwatch = net.watch(session.code, onHostSnap, { host: true });
}
// QR code of the join link (code included, so students only type their name). Optional: if the
// library did not load, the box stays empty and hidden and the written link is still shown.
function renderJoinQr(link) {
  const box = $('hQr'); box.replaceChildren(); box.dataset.ok = '';
  if (typeof window.qrcode !== 'function') return;
  try {
    const qr = window.qrcode(0, 'M'); qr.addData(link); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    box.dataset.ok = '1';
  } catch (e) { console.warn('[sf] QR code failed', e); }
}
function hostShiftTime() { return snap && snap.comp.started_at ? (net.serverNow() - Date.parse(snap.comp.started_at)) / 1000 : 0; }
function hostAction(label, cls, fn) { return board.h('button', { class: 'btn ' + (cls || ''), text: label, onclick: async ev => { const b = ev.currentTarget; b.disabled = true; try { await fn(b); } catch (ex) { alert(ex.message); } finally { b.disabled = false; } } }); }
function onHostSnap(s) {
  if (!session || session.role !== 'host') return;
  if (s.comp.host_id !== net.me) { goHome('This browser is not the host of that competition.'); return; }
  snap = s;
  const c = s.comp, st = c.status, nReal = s.players.filter(p => !p.simulated).length, nSim = s.players.length - nReal;
  $('hStatus').textContent = { lobby: 'Lobby · waiting to start', running: hostShiftTime() < 0 ? 'Starting…' : 'Shift running', finished: 'Shift over', revealed: 'Winners announced' }[st];
  $('hModeTxt').textContent = (c.mode === 'team' ? `Team mode · teams of ${c.team_size} · ranked by average` : 'Individual mode') + ` · ${nReal} real` + (nSim ? ` + ${nSim} simulated` : '');
  // actions
  const act = $('hActions'); act.replaceChildren();
  if (st === 'lobby') {
    const startBtn = hostAction('Start competition', 'primary big', () => net.startCompetition(c.code));
    startBtn.disabled = !s.players.length;
    act.append(startBtn, hostAction('Cancel', '', async () => { if (confirm('Leave this competition? Students in the lobby will stay waiting.')) goHome(); }));
  } else if (st === 'running') {
    act.append(hostAction('End shift now', 'danger', async b => {
      if (!endArm) { b.textContent = 'Click again to end for everyone'; endArm = setTimeout(() => { endArm = null; b.textContent = 'End shift now'; }, 3000); return; }
      clearTimeout(endArm); endArm = null; await net.endCompetition(c.code);
    }));
  } else if (st === 'finished') {
    const finals = s.players.filter(p => p.final).length;
    act.append(board.h('span', { class: 'note', text: `${finals} of ${s.players.length} final results received` }),
      hostAction('Announce winners', 'primary big', () => net.revealWinners(c.code)));
  } else {
    act.append(hostAction('Show winners', 'primary', async () => { shownRevealAt = null; onHostSnap(snap); }), hostAction('New competition', '', async () => goHome()));
  }
  // lobby card (+ join QR: joining is only possible in the lobby)
  $('hLobbyCard').hidden = st !== 'lobby';
  $('hQr').hidden = st !== 'lobby' || !$('hQr').dataset.ok;
  if (st === 'lobby') {
    document.querySelectorAll('input[name=hcMode]').forEach(r => r.checked = r.value === c.mode);
    if (document.activeElement !== $('hcSize')) $('hcSize').value = c.team_size;
    document.querySelectorAll('#scrHost .team-only2').forEach(el => el.hidden = c.mode !== 'team');
    $('hCount').textContent = `${s.players.length} joined` + (nSim ? ` (${nSim} simulated)` : '') + ` · up to ${rules.RULES.MAX_PLAYERS}`;
    board.roster($('hRoster'), s, { onKick: p => { if (confirm(`Remove ${p.name} from the competition?`)) net.kickPlayer(c.code, p.id).catch(e => alert(e.message)); } });
  }
  // live board
  $('hLiveCard').hidden = st === 'lobby';
  document.querySelectorAll('#hView .team-only2').forEach(el => el.hidden = c.mode !== 'team');
  if (c.mode !== 'team') hView = 'players';
  document.querySelectorAll('#hView .btn').forEach(b => b.setAttribute('aria-selected', b.dataset.v === hView));
  if (st !== 'lobby') board.live($('hBoard'), s, { view: hView });
  $('hEvents').hidden = st !== 'running';
  // bots
  if (net.supportsSimulated && (st === 'running' || st === 'finished')) syncBots();
  // projector switches to the winner screen
  if (st === 'revealed' && shownRevealAt !== c.revealed_at) {
    shownRevealAt = c.revealed_at; show('scrResults'); board.results(s, {});
  } else if (st !== 'revealed' && $('scrHost').hidden) show('scrHost');
}
function bindHost() {
  document.querySelectorAll('input[name=hcMode]').forEach(r => r.addEventListener('change', () => net.setMode(session.code, r.value, +$('hcSize').value).catch(e => alert(e.message))));
  $('hcSize').addEventListener('change', () => net.setMode(session.code, 'team', +$('hcSize').value).catch(e => alert(e.message)));
  $('hAssign').onclick = () => net.assignTeams(session.code).catch(e => alert(e.message));
  $('simAdd1').onclick = () => net.addSimulated(session.code, 1).catch(e => alert(e.message));
  $('simAdd5').onclick = () => net.addSimulated(session.code, 5).catch(e => alert(e.message));
  $('simFill').onclick = () => net.addSimulated(session.code, Math.max(0, 25 - (snap ? snap.players.length : 0))).catch(e => alert(e.message));
  $('simClear').onclick = () => net.removeSimulated(session.code).catch(e => alert(e.message));
  $('hView').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; hView = b.dataset.v; if (snap) onHostSnap(snap); });
  const ev = $('hEvBtns');
  sim.DEF.forEach((d, i) => {
    ev.append(hostAction(`Break ${d.name}`, '', () => net.hostEvent(session.code, 'break', i)),
      hostAction(`Coolant fault: ${d.name}`, '', () => net.hostEvent(session.code, 'fault', i)));
  });
  // host clock + automatic end of the shift
  setInterval(() => {
    if (!session || session.role !== 'host' || !snap) return;
    const c = snap.comp;
    if (c.status === 'lobby') { $('hClock').textContent = '0:00 / 6:00'; return; }
    const t = hostShiftTime();
    let shown = Math.max(0, Math.min(t, sim.SHIFT));
    if (c.ended_at) shown = Math.min(shown, (Date.parse(c.ended_at) - Date.parse(c.started_at)) / 1000);
    $('hClock').textContent = t < 0 && c.status === 'running' ? `starts in ${Math.ceil(-t)} s` : `${fmt(shown)} / 6:00`;
    if (c.status === 'running' && t >= sim.SHIFT + 1 && !autoEnding) {
      autoEnding = true; net.endCompetition(c.code).catch(() => {}).finally(() => { autoEnding = false; });
    }
    if (net.supportsSimulated && (c.status === 'running' || c.status === 'finished')) tickBots();
  }, 500);
}

// ---------- simulated players (mock backend only; played by the host tab)
let bots = new Map(), botComp = null, botReportAcc = 0, botsFinal = false;
function stopBots() { bots = new Map(); botComp = null; botsFinal = false; }
function syncBots() {
  const c = snap.comp;
  if (botComp !== c.code + c.seed) { stopBots(); botComp = c.code + c.seed; }
  net.simulatedPlayers(c.code).forEach(p => {
    if (!bots.has(p.id)) bots.set(p.id, SF.bot.createBot(Number(c.seed), p.skill, p.bot_seed));
  });
  bots.forEach(b => {
    b.S.seen = b.S.seen || [];
    snap.events.forEach(e => { if (!b.S.seen.includes(e.id)) { b.S.seen.push(e.id); sim.schedule(b.S, { kind: e.kind, machine: e.machine, at: Math.max(Number(e.at), b.S.t) }); } });
  });
}
function tickBots() {
  if (!bots.size || botsFinal) return;
  const c = snap.comp;
  let t = Math.min(hostShiftTime(), sim.SHIFT);
  if (t < 0) return;
  if (c.ended_at) t = Math.min(t, (Date.parse(c.ended_at) - Date.parse(c.started_at)) / 1000);
  bots.forEach(b => SF.bot.advanceTo(b, t));
  const ended = !!c.ended_at || t >= sim.SHIFT;
  botReportAcc += 0.5;
  if (ended) {
    bots.forEach(b => sim.endShift(b.S));
    botsFinal = true;
    net.submitSimulated(c.code, [...bots].map(([id, b]) => ({ id, stats: sim.stats(b.S) })), true);
  } else if (botReportAcc >= 3) {
    botReportAcc = 0;
    net.submitSimulated(c.code, [...bots].map(([id, b]) => ({ id, stats: sim.stats(b.S) })), false);
  }
}

// ---------- results screen buttons
function bindResults() {
  $('rsReplay').onclick = () => { if (snap) board.results(snap, { meId: session && session.playerId }); };
  $('rsHome').onclick = () => { if (session && session.role === 'host') { show('scrHost'); } else goHome(); };
}

// ---------- boot
async function boot() {
  initChips();
  game.init({ onExit: () => { show('scrHome'); setWho(''); } });
  bindHome(); bindHost(); bindResults();
  $('lLeave').onclick = async () => { const c = session && session.code; try { if (c) await net.leaveCompetition(c); } catch (e) {} goHome(); };
  show('scrHome');
  try { await net.init(); }
  catch (ex) {
    const msg = ex.message + (net.kind === 'supabase' ? ' — open this page with ?backend=mock to demo without the server.' : '');
    err($('jErr'), msg); err($('hErr'), msg); return;
  }
  // resume after a reload
  const s = loadSession();
  if (s) {
    session = s;
    if (s.role === 'host') enterHost();
    else net.joinCompetition(s.code, s.name).then(r => { saveSession({ ...s, playerId: r.player.id }); enterPlayer(); })
      .catch(ex => goHome('Could not rejoin: ' + ex.message));
  } else if ($('jCode').value) $('jName').focus();
  showResume();
}
boot();
})(window.SF = window.SF || {});
