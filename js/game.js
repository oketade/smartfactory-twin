/* Control room: the 1.0 player interface on top of the simulation engine.
   Two modes:
   - practice:     original single-player shift (pause, time ×4, restart, instructor panel, local leaderboard)
   - competition:  clock follows the server's start time, host events arrive scheduled, no pause/restart,
                   progress is reported every 5 s and the final result is submitted automatically. */
(function (SF) {
'use strict';
const sim = SF.sim, { h } = SF.board;
const $ = id => document.getElementById(id);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let S = null, ctx = null, sel = 2, running = false, paused = false, fast = false, repairKey = false, repairBtn = -1;
let catching = false, onExit = null;

const handlers = {
  log: msg => log(msg),
  toast: msg => { if (!catching) toast(msg); },
  mission: () => showMission(),
  end: () => onShiftEnd(),
};
const input = () => ({ repair: repairBtn >= 0 ? repairBtn : repairKey ? sel : -1 });
const canAct = () => S && running && !paused && !S.over && (!ctx || ctx.kind !== 'comp' || shiftTime() >= 0);

function log(msg) { const li = document.createElement('li'); li.innerHTML = '<time></time><span></span>'; li.firstChild.textContent = fmt(S ? S.t : 0); li.lastChild.textContent = msg; $('log').prepend(li); while ($('log').children.length > 120) $('log').lastChild.remove(); }
let tt; function toast(msg) { const el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 3500); }

// ---------- build once
function buildRows() {
  $('rows').innerHTML = '';
  sim.DEF.forEach((d, i) => {
    const r = document.createElement('div'); r.className = 'row'; r.id = 'row' + i;
    r.innerHTML = `<div><div class="row-top"><span class="row-name">${d.name}</span><span class="chip" id="chip${i}">NORMAL</span><span class="fault" id="flt${i}" hidden>Coolant fault</span></div></div>
      <div class="temp num" id="tmp${i}">--<small> °C</small></div>
      <div class="meta"><span class="lbl">Health</span><span class="hbar"><i id="hb${i}"></i></span><span class="num" id="hv${i}">100%</span></div>
      <div class="fc"><span class="lbl">Forecast</span><span id="fc${i}">stable</span></div>
      <canvas class="spark" id="sp${i}" height="44"></canvas>
      <div class="row-ctl"><button class="btn" id="tog${i}">Switch OFF</button><button class="btn hold" id="rep${i}"><i id="repf${i}"></i>Hold to repair</button></div>`;
    r.addEventListener('click', () => select(i));
    $('rows').appendChild(r);
    $('tog' + i).addEventListener('click', e => { e.stopPropagation(); select(i); toggle(i); });
    const rb = $('rep' + i);
    const down = e => { e.preventDefault(); e.stopPropagation(); select(i); repairBtn = i; };
    const up = () => { if (repairBtn === i) repairBtn = -1; };
    rb.addEventListener('pointerdown', down); rb.addEventListener('pointerup', up); rb.addEventListener('pointerleave', up); rb.addEventListener('pointercancel', up);
    rb.addEventListener('contextmenu', e => e.preventDefault());
    rb.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select(i); repairBtn = i; } });
    rb.addEventListener('keyup', up);
  });
  const st = $('steps'); st.innerHTML = '';
  sim.MISSIONS.forEach((m, i) => { const s = document.createElement('span'); s.className = 'step'; s.id = 'st' + i; s.textContent = `M${i + 1}`; s.title = m.t; st.appendChild(s); });
}

function select(i) { sel = i; render(); }
function toggle(i) { if (!canAct()) return; if (sim.toggle(S, i)) render(); }
function setSpeed(v) { if (!S) return; sim.setSpeed(S, v); render(); }

function showMission() {
  if (!S) return;
  const k = S.mission;
  if (k >= sim.MISSIONS.length) { $('mLabel').textContent = 'All missions done'; $('mTitle').textContent = 'Keep the factory running until the shift ends'; $('mText').textContent = 'Maximise output without breakdowns to raise your score.'; $('mBar').style.width = '100%'; }
  else { $('mLabel').textContent = `Mission ${k + 1} of 4 · unlocks output ×${sim.multOf(k + 1).toFixed(k === 2 ? 2 : 1)}`; $('mTitle').textContent = sim.MISSIONS[k].t; $('mText').textContent = sim.MISSIONS[k].d; $('mBar').style.width = '0%'; }
  sim.MISSIONS.forEach((_, i) => { $('st' + i).className = 'step' + (i < k ? ' done' : i === k ? ' now' : ''); });
}

// ---------- render
function spark(i) {
  const c = $('sp' + i), w = c.clientWidth || 300, hh = 44, dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = hh * dpr; }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, hh);
  const y = v => hh - 4 - ((v - 20) / 100) * (hh - 8);
  [[70, 'rgba(242,182,50,.45)'], [85, 'rgba(255,90,90,.5)']].forEach(([v, c2]) => { x.strokeStyle = c2; x.setLineDash([3, 4]); x.beginPath(); x.moveTo(0, y(v)); x.lineTo(w, y(v)); x.stroke(); });
  x.setLineDash([]);
  const hs = S.m[i].hist; if (hs.length < 2) return;
  const sx = w / 59;
  x.beginPath(); hs.forEach((v, j) => { const px = (60 - hs.length + j) * sx; j ? x.lineTo(px, y(v)) : x.moveTo(px, y(v)); });
  x.strokeStyle = '#2fd3f5'; x.lineWidth = 1.6; x.stroke();
  const lx = 59 * sx, ly = y(hs[hs.length - 1]); x.fillStyle = '#2fd3f5'; x.beginPath(); x.arc(Math.min(lx, w - 3), ly, 2.6, 0, 7); x.fill();
}
function render() {
  if (!S || $('scrGame').hidden) return;
  SF.floor.update(S, sel);
  S.m.forEach((m, i) => {
    const s = sim.state(m);
    $('row' + i).classList.toggle('sel', sel === i);
    const chip = $('chip' + i); chip.textContent = sim.label(m); chip.className = 'chip c-' + s;
    $('tmp' + i).innerHTML = `${m.T.toFixed(1)}<small> °C</small>`; $('tmp' + i).className = 'temp num c-' + s;
    $('flt' + i).hidden = !m.fault;
    $('tog' + i).textContent = m.broken ? 'Broken' : m.on ? 'Switch OFF' : 'Switch ON';
    $('tog' + i).disabled = m.broken;
    $('repf' + i).style.width = (m.rep / 3 * 100) + '%';
    const hc = m.health < 30 ? 'var(--bad)' : m.health < 60 ? 'var(--warn)' : 'var(--ok)';
    $('hb' + i).style.width = m.health + '%'; $('hb' + i).style.background = hc; $('hv' + i).textContent = Math.round(m.health) + '%';
    const f = sim.forecast(S, m), fe = $('fc' + i);
    if (!f) fe.innerHTML = m.broken ? '<b class="c-bad">needs repair</b>' : 'machine is off, cooling down';
    else if (f.kind === 'heat') fe.innerHTML = `<b class="c-bad">will overheat in ~${Math.ceil(f.t)} s</b>`;
    else if (f.kind === 'wear') fe.innerHTML = `<b class="c-bad">will wear out in ~${Math.ceil(f.t)} s</b>`;
    else { const c = f.eq >= 85 ? 'c-bad' : f.eq >= 70 ? 'c-warn' : 'c-ok'; fe.innerHTML = `settles near <b class="${c}">${Math.round(f.eq)} °C</b>`; }
    spark(i);
  });
  renderWhatIf();
  $('kOut').textContent = Math.round(S.out); $('kBrk').textContent = S.brk; $('kSpd').textContent = S.speed.toFixed(1) + '×';
  $('clock').textContent = `${fmt(Math.min(S.t, sim.SHIFT))} / 6:00`;
  $('gScore').textContent = sim.score(S); $('gMult').textContent = '×' + sim.multOf(S.mDone).toFixed(S.mDone === 3 ? 2 : 1);
  if (S.mission < sim.MISSIONS.length) $('mBar').style.width = Math.min(100, S.mProg * 100) + '%';
  $('ev1').className = 'step' + (S.ev[0] ? ' done' : ''); $('ev2').className = 'step' + (S.ev[1] ? ' done' : ''); $('ev3').className = 'step' + (S.over ? ' done' : '');
}
function renderWhatIf() {
  const s = S.wiSpeed; $('wiSpd').textContent = s.toFixed(1) + '×';
  let units = 0;
  $('wiGrid').innerHTML = S.m.map(m => {
    if (!m.on || m.broken) return `<div class="wi"><span class="lbl">${m.name}</span><span class="num c-off">${m.broken ? 'BROKEN' : 'OFF'}</span><span>not running</span></div>`;
    units += sim.RATE * s; const eq = sim.steady(m, s);
    const st = eq > 95 ? ['c-bad', 'would break down'] : eq > 85 ? ['c-bad', 'overheat'] : eq >= 70 ? ['c-warn', 'warning'] : ['c-ok', 'normal'];
    return `<div class="wi"><span class="lbl">${m.name}</span><span class="num ${st[0]}">${Math.round(eq)} °C</span><span class="${st[0]}">${st[1]}</span></div>`;
  }).join('');
  $('wiOut').textContent = units.toFixed(1);
}

let lastFrame = performance.now();
function anim(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  if (S && running && !paused && !S.over && !$('scrGame').hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) SF.floor.animate(S, dt);
  requestAnimationFrame(anim);
}

// ---------- clock
const shiftTime = () => (ctx.net.serverNow() - Date.parse(ctx.comp.started_at)) / 1000;
let last = performance.now(), saveAcc = 0, reportAcc = 0;
function loop() {
  const now = performance.now(), real = Math.min(0.25, (now - last) / 1000); last = now;
  if (!S || !running) return;
  if (!ctx) { if (!paused) { sim.advance(S, real * (fast ? 4 : 1), input); render(); } return; }
  // competition: follow the shared clock
  const t = shiftTime();
  const cd = $('cdOv');
  if (t < 0) {
    const n = Math.ceil(-t);
    if (cd.hidden) cd.hidden = false;
    if ($('cdNum').textContent !== String(n)) { $('cdNum').textContent = n; $('cdNum').classList.remove('tick'); void $('cdNum').offsetWidth; $('cdNum').classList.add('tick'); }
    return;
  }
  if (!cd.hidden) { cd.hidden = true; log('Shift started. Oven C is already running hot.'); }
  let target = Math.min(t, sim.SHIFT);
  if (ctx.comp.ended_at) target = Math.min(target, Math.max(0, (Date.parse(ctx.comp.ended_at) - Date.parse(ctx.comp.started_at)) / 1000));
  catching = target - S.t > 3;
  while (!S.over && S.t + sim.TICK <= target + 1e-9) sim.tick(S, input());
  catching = false;
  if (!S.over && ctx.comp.ended_at && S.t + sim.TICK > target) { log('HOST: competition ended early'); sim.endShift(S); }
  render();
  // wall-clock time, not the capped `real`: background tabs tick only ~1×/s and would report 4× too rarely
  const wall = Math.min(10, (now - (loop.lastWall || now)) / 1000); loop.lastWall = now;
  saveAcc += wall; reportAcc += wall;
  if (saveAcc >= 2) { saveAcc = 0; persist(); }
  // progress reports are best-effort: a failed one is replaced by the next (5 s later) and by the final submit
  if (reportAcc >= 5 && !S.over) { reportAcc = 0; report(false).catch(e => console.warn('[sf] progress report failed:', e.message)); }
}
setInterval(loop, 100);

// ---------- competition plumbing
const runKey = () => `sf2-run:${ctx.comp.id}:${ctx.player.id}`;
function persist() { if (!ctx || !S) return; try { sessionStorage.setItem(runKey(), sim.serialize(S)); } catch (e) {} }
function report(final) {
  if (!ctx) return Promise.resolve();
  return ctx.net.submitResult(ctx.comp.code, ctx.player.id, sim.stats(S), final);
}
function scheduleEvents(events) {
  if (!S || !events) return;
  S.seen = S.seen || [];
  events.forEach(e => {
    if (S.seen.includes(e.id)) return;
    S.seen.push(e.id);
    sim.schedule(S, { kind: e.kind, machine: e.machine, at: Math.max(Number(e.at), S.t) });
  });
}

function onShiftEnd() {
  running = !!ctx; // keep the competition loop alive for the frozen view
  $('rOut').textContent = Math.round(S.out); $('rBonus').textContent = '+' + Math.round(S.bonus || 0); $('rBrk').textContent = S.brk; $('rMis').textContent = `${S.mDone} / 4`; $('rScore').textContent = sim.score(S);
  $('rTitle').textContent = S.brk === 0 ? 'Clean shift: no breakdowns' : 'Shift complete';
  $('ev3').className = 'step done';
  if (!ctx) {
    $('rCodeBox').hidden = false; $('rPracticeBtns').hidden = false; $('rCompBtns').hidden = true; $('rSubmit').hidden = true;
    $('rNote').textContent = 'Score = output + level bonus + 150 per mission − 200 per breakdown. Tell the presenters your name, score and result code so they can add you to the class leaderboard.';
    $('rName').textContent = player || 'Unnamed'; $('rCode').textContent = resultCode(player, sim.score(S));
    addToBoard({ name: player || 'Unnamed', score: sim.score(S), brk: S.brk });
    $('btnStart').textContent = 'Start shift';
  } else {
    $('rCodeBox').hidden = true; $('rPracticeBtns').hidden = true; $('rCompBtns').hidden = false;
    $('rNote').textContent = 'Your result is sent automatically. The server checks it and calculates the official score.';
    persist(); submitFinal();
  }
  $('endOv').hidden = false;
  render();
}
function submitFinal(attempt) {
  attempt = attempt || 0;
  const el = $('rSubmit'); el.hidden = false; el.className = 'submit'; el.textContent = 'Submitting result to the server…';
  report(true).then(r => {
    el.className = 'submit c-ok'; el.textContent = `✓ Result recorded. Official score: ${r.score}`;
    ctx.submitted = true;
  }).catch(err => {
    if (/already recorded/i.test(err.message)) { el.className = 'submit c-ok'; el.textContent = '✓ Result already recorded.'; ctx.submitted = true; return; }
    if (attempt < 12 && !/closed|not registered|outside|backwards|Malformed/i.test(err.message)) {
      el.className = 'submit c-warn'; el.textContent = `Could not submit yet (${err.message}). Retrying…`;
      setTimeout(() => ctx && submitFinal(attempt + 1), 3000);
    } else { el.className = 'submit c-bad'; el.textContent = `Result not accepted: ${err.message}`; }
  });
}

// ---------- practice registration + leaderboard (unchanged from 1.0)
let player = '';
try { player = localStorage.getItem('sf-player') || ''; } catch (e) {}
function resultCode(name, sc) {
  const s = (name || '').trim().toLowerCase() + '|' + sc + '|sf26'; let hh = 7;
  for (const ch of s) hh = (Math.imul(hh, 31) + ch.codePointAt(0)) >>> 0;
  return hh.toString(36).toUpperCase().slice(-4).padStart(4, '0');
}
function loadBoard() { try { return JSON.parse(localStorage.getItem('sf-board') || '[]'); } catch (e) { return []; } }
let board = loadBoard();
function saveBoard() { try { localStorage.setItem('sf-board', JSON.stringify(board)); } catch (e) {} }
function addToBoard(entry) { board.push({ ...entry, id: Date.now() + Math.random() }); saveBoard(); renderBoard(); }
function renderBoard() {
  const tb = $('board'); tb.innerHTML = '';
  const rows = [...board].sort((a, b) => b.score - a.score);
  if (!rows.length) { tb.append(h('tr', null, h('td', { class: 'empty', colspan: 5, text: 'No results yet. Scores appear here after each shift, or add classmates’ results above.' }))); return; }
  rows.forEach((r, i) => tb.append(h('tr', { class: i === 0 ? 'top1' : null },
    h('td', { class: 'n', text: i + 1 }), h('td', { text: r.name }), h('td', { class: 'n', text: r.score }), h('td', { class: 'n', text: r.brk == null ? '–' : r.brk }),
    h('td', null, h('button', { class: 'x', 'aria-label': 'Remove ' + r.name, text: 'Remove', onclick: () => { board = board.filter(x => x.id !== r.id); saveBoard(); renderBoard(); } })))));
}

// ---------- start / stop
function resetView() {
  $('log').innerHTML = ''; $('endOv').hidden = true; $('cdOv').hidden = true;
  repairBtn = -1; repairKey = false; sel = 2; paused = false;
  $('btnPause').textContent = 'Pause';
}
function practice(name) {
  ctx = null; player = name; try { localStorage.setItem('sf-player', name); } catch (e) {}
  document.body.classList.remove('in-comp');
  $('practiceCtl').hidden = false; $('gRankBox').hidden = true; $('gStandings').hidden = true; $('gTeam').hidden = true;
  $('gModeLbl').textContent = 'Practice shift · this device only';
  document.querySelectorAll('.practice-only').forEach(e => e.hidden = false);
  restartPractice();
}
function restartPractice() {
  resetView();
  S = sim.fresh(null, handlers); running = true;
  $('btnStart').textContent = 'Restart shift';
  log('Shift started. Oven C is already running hot.'); showMission(); render();
}
function competition(c) {
  // c: { comp, player, net, team }
  ctx = { kind: 'comp', ...c, submitted: false };
  $('instr').hidden = true;
  $('practiceCtl').hidden = true; $('gRankBox').hidden = false; $('gStandings').hidden = false;
  document.querySelectorAll('.practice-only').forEach(e => e.hidden = true);
  $('gModeLbl').textContent = `Competition ${c.comp.code} · ${c.comp.mode === 'team' ? 'team mode' : 'individual mode'}`;
  setTeam(c.team);
  resetView();
  let saved = null; try { saved = sessionStorage.getItem(runKey()); } catch (e) {}
  if (saved) { S = sim.restore(saved, handlers); log('Reconnected: resuming your shift.'); }
  else S = sim.fresh(Number(c.comp.seed), handlers);
  running = true; saveAcc = 0; reportAcc = 0;
  showMission();
  if (S.over) onShiftEnd(); else render();
}
function setTeam(team) {
  const t = $('gTeam');
  if (team) { t.hidden = false; t.textContent = team.name; t.style.setProperty('--tc', team.color); } else t.hidden = true;
}
// called by the app with every competition snapshot
function onSnapshot(snap) {
  if (!ctx || !S) return;
  ctx.comp = snap.comp;
  scheduleEvents(snap.events);
  const me = snap.players.find(p => p.id === ctx.player.id);
  if (me) {
    $('gRank').textContent = `#${me.rank} / ${snap.players.length}`;
    const t = snap.teams.find(t => t.id === me.team_id); setTeam(t);
  }
  SF.board.live($('gBoard'), snap, { meId: ctx.player.id, limit: 5, noPodium: true, view: snap.comp.mode === 'team' ? 'teams' : 'players' });
}
function stop() { running = false; ctx = null; S = null; $('endOv').hidden = true; $('cdOv').hidden = true; $('instr').hidden = true; }

// ---------- inputs
function bind() {
  $('btnAgain').onclick = restartPractice;
  $('btnNew').onclick = () => { stop(); onExit && onExit(); };
  $('btnExit').onclick = () => { stop(); onExit && onExit(); };
  $('btnStart').onclick = () => restartPractice();
  $('btnPause').onclick = () => { if (!running || ctx) return; paused = !paused; $('btnPause').textContent = paused ? 'Resume' : 'Pause'; };
  $('btnFast').onclick = () => { fast = !fast; $('btnFast').textContent = fast ? 'Time ×4' : 'Time ×1'; $('btnFast').setAttribute('aria-pressed', fast); };
  $('btnStand').onclick = () => { $('endOv').hidden = true; $('gStandings').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('spUp').onclick = () => setSpeed(S.speed + .1); $('spDn').onclick = () => setSpeed(S.speed - .1);
  const setWi = v => { if (!S) return; S.wiSpeed = sim.clampSpeed(v); renderWhatIf(); };
  $('wiUp').onclick = () => setWi(S.wiSpeed + .1); $('wiDn').onclick = () => setWi(S.wiSpeed - .1);
  $('wiApply').onclick = () => { if (!canAct()) return; setSpeed(S.wiSpeed); log(`Speed set to ${S.speed.toFixed(1)}× after what-if test`); };
  // practice instructor panel
  $('iBreak').onclick = () => { if (!running || ctx || S.over) return; sim.breakMachine(S, sel, 'INSTRUCTOR'); render(); };
  $('iFault').onclick = () => { if (!running || ctx || S.over) return; sim.coolantFault(S, sel, 'INSTRUCTOR'); render(); };
  $('iSkip').onclick = () => { if (running && !ctx) sim.skipMission(S); };
  $('iEnd').onclick = () => { if (running && !ctx && !S.over) sim.endShift(S); };
  $('addForm').addEventListener('submit', e => {
    e.preventDefault();
    const n = $('aName').value.trim(), s = $('aScore').value.trim(), c = $('aCode').value.trim().toUpperCase(), err = $('aErr');
    if (n.length < 2 || s === '' || !/^-?\d+$/.test(s)) { err.textContent = 'Enter a name and a whole-number score.'; err.hidden = false; return; }
    if (c !== resultCode(n, +s)) { err.textContent = 'That code does not match this name and score. Check the spelling of the name.'; err.hidden = false; return; }
    err.hidden = true; addToBoard({ name: n, score: +s, brk: null }); $('addForm').reset(); $('aName').focus();
  });
  let clearArm = null;
  $('bClear').onclick = () => {
    if (!clearArm) { $('bClear').textContent = 'Click again to clear all'; clearArm = setTimeout(() => { clearArm = null; $('bClear').textContent = 'Clear leaderboard'; }, 3000); return; }
    clearTimeout(clearArm); clearArm = null; board = []; saveBoard(); renderBoard(); $('bClear').textContent = 'Clear leaderboard';
  };
  document.addEventListener('keydown', e => {
    if ($('scrGame').hidden) return;
    if (e.target.closest('input')) return;
    if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    const k = e.key.toLowerCase();
    if (k === 'i') { if (!ctx) $('instr').hidden = !$('instr').hidden; return; }
    if (!S) return;
    if (k === '1' || k === '2' || k === '3') select(+k - 1);
    else if (k === 'e') toggle(sel);
    else if (k === 'r') repairKey = true;
    else if (k === '+' || k === '=') setSpeed(S.speed + .1);
    else if (k === '-' || k === '_') setSpeed(S.speed - .1);
    else if (k === ' ' && !ctx) { e.preventDefault(); $('btnPause').click(); }
  });
  document.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'r') repairKey = false; });
  window.addEventListener('blur', () => { repairKey = false; repairBtn = -1; });
  window.addEventListener('resize', render);
}

function init(opts) {
  onExit = opts.onExit;
  SF.floor.build($('floor'), select);
  buildRows(); bind(); renderBoard();
  $('pName').value = player;
  requestAnimationFrame(anim);
}

SF.game = { init, practice, competition, onSnapshot, stop, render, get active() { return !!ctx; }, get submitted() { return !!(ctx && ctx.submitted); } };
})(window.SF = window.SF || {});
