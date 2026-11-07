/* SmartFactory Twin — simulation engine.
   Ported from the 1.0 prototype with the same constants, heat model, wear, faults,
   breakdowns, repair, forecast, what-if and missions. Two changes for competition fairness:
   - noise comes from a seeded RNG (same seed => same noise for every student)
   - the engine advances in fixed 0.1 s ticks, so the result does not depend on frame rate.
   No DOM access here: the UI and the simulated players both drive this module. */
(function (SF) {
'use strict';

const SHIFT = 360, AMB = 25, K = 0.05, RATE = 4, TICK = 0.1;
const DEF = [
  { name: 'Press A',  H: 1.5,  T0: 45 },
  { name: 'Cutter B', H: 2.0,  T0: 50 },
  { name: 'Oven C',   H: 2.75, T0: 86 },
];
const MISSIONS = [
  { t: 'Find the overheating machine and switch it OFF', d: 'Read the dashboard. One machine is already in the red. Shut it down before it breaks.' },
  { t: 'All three ON and green for 60 seconds', d: 'Restart the machine you stopped. Use the What-if test to find a speed where every machine stays under 70 °C, then apply it.' },
  { t: 'Produce 600 units in 60 seconds, no breakdowns', d: 'Now push for output. Raise the speed, but watch the hottest machine. A breakdown restarts the attempt.' },
  { t: 'Full production for 30 seconds', d: 'All machines ON, no faults, speed at 1.0× or higher. Repair anything that is broken or faulted first.' },
];
// Scoring rule shown to players. The authoritative calculation runs server-side
// (supabase/schema.sql: sf_score) — this copy is only for the on-screen preview.
const scoreOf = (out, mDone, brk) => Math.round(out) + 150 * mDone - 200 * brk;
const MAX_OUTPUT = Math.ceil(DEF.length * RATE * 2.0 * SHIFT); // 8640: all machines at 2.0× for the whole shift

// mulberry32: small, fast, deterministic
function rng(seed) {
  let a = seed >>> 0;
  const next = function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.getState = () => a;
  next.setState = v => { a = v >>> 0; };
  return next;
}

// save / restore a running shift (lets a student reload the page mid-competition)
function serialize(S) {
  const { rand, on, ...rest } = S;
  return JSON.stringify({ ...rest, rngState: rand.getState() });
}
function restore(json, on) {
  const o = JSON.parse(json);
  const S = fresh(0, on);
  const { rngState, ...rest } = o;
  Object.assign(S, rest);
  S.rand.setState(rngState);
  return S;
}

const noop = () => {};
function fresh(seed, on) {
  return {
    t: 0, speed: 1.0, wiSpeed: 1.0, out: 0, brk: 0, mission: 0, mDone: 0, mTimer: 0, m3Start: 0, m3Units: 0,
    mProg: 0, ev: [false, false], over: false, acc: 0, histAcc: 0, scheduled: [],
    rand: rng(seed == null ? (Math.random() * 2 ** 32) >>> 0 : seed),
    on: Object.assign({ log: noop, toast: noop, mission: noop, end: noop }, on || {}),
    m: DEF.map(d => ({ ...d, T: d.T0, on: true, broken: false, fault: false, hot: 0, rep: 0, hist: [], health: d.T0 > 80 ? 70 : 100, warned: false })),
  };
}

// wear per second while running: heavier when hot
const wear = T => 0.15 + Math.max(0, T - 70) * 0.03 + Math.max(0, T - 85) * 0.1;
const heatOf = (m, speed) => (m.on && !m.broken) ? m.H * speed * (m.fault ? 2 : 1) : 0;
const steady = (m, speed) => AMB + heatOf(m, speed) / K;
// look 60 s ahead with the current settings (no noise)
function forecast(S, m) {
  if (!m.on || m.broken) return null;
  const heat = heatOf(m, S.speed); let T = m.T, h = m.health;
  for (let t = 0.5; t <= 60; t += 0.5) {
    T += (heat - K * (T - AMB)) * 0.5; h -= wear(T) * 0.5;
    if (T > 95) return { kind: 'heat', t };
    if (h <= 0) return { kind: 'wear', t };
  }
  return { kind: 'ok', eq: steady(m, S.speed) };
}
const state = m => m.broken ? 'bad' : !m.on ? 'off' : m.T > 85 ? 'bad' : m.T >= 70 ? 'warn' : 'ok';
const label = m => m.broken ? 'BROKEN' : !m.on ? 'OFF' : m.T > 85 ? 'OVERHEAT' : m.T >= 70 ? 'WARNING' : 'NORMAL';

// ---------- operator actions
function toggle(S, i) {
  if (S.over) return false;
  const m = S.m[i];
  if (m.broken) { S.on.toast(`${m.name} is broken. Hold Repair to fix it.`); return false; }
  m.on = !m.on; S.on.log(`${m.name} switched ${m.on ? 'ON' : 'OFF'}`);
  return true;
}
const clampSpeed = v => Math.round(Math.min(2, Math.max(0.5, v)) * 10) / 10;
function setSpeed(S, v) { S.speed = clampSpeed(v); }

// external events (instructor / competition host)
function breakMachine(S, i, who) {
  const m = S.m[i];
  if (m.broken) return;
  m.broken = true; m.on = false; S.brk++;
  S.on.log(`${who}: ${m.name} broken`);
  S.on.toast(`${who}: ${m.name} has been broken. Repair it.`);
}
function coolantFault(S, i, who) {
  S.m[i].fault = true;
  S.on.log(`${who}: coolant fault on ${S.m[i].name}`);
  S.on.toast(`${who}: coolant fault on ${S.m[i].name}`);
}
// host events are scheduled at a shift time so every student receives them at the same moment
function schedule(S, ev) { S.scheduled.push(ev); S.scheduled.sort((a, b) => a.at - b.at); }

// ---------- one fixed tick (TICK seconds of shift time)
function tick(S, input) {
  const dt = TICK;
  S.t = Math.round((S.t + dt) * 1000) / 1000;
  while (S.scheduled.length && S.scheduled[0].at <= S.t) {
    const e = S.scheduled.shift();
    if (e.kind === 'break') breakMachine(S, e.machine, 'HOST');
    else if (e.kind === 'fault') coolantFault(S, e.machine, 'HOST');
  }
  // scripted events
  if (!S.ev[0] && S.t >= 150) { S.ev[0] = true; S.m[1].fault = true; S.on.log('EVENT: Cutter B coolant fault. Heat ×2 until repaired.'); S.on.toast('Cutter B coolant fault: it now heats twice as fast'); }
  if (!S.ev[1] && S.t >= 270) { S.ev[1] = true; const o = S.m[2]; if (!o.broken) { o.broken = true; o.on = false; S.brk++; S.on.log('EVENT: Oven C tripped (electrical fault).'); S.on.toast('Oven C has tripped. Repair it to restore output.'); } }
  S.m.forEach((m, i) => {
    const running = m.on && !m.broken;
    const heat = running ? m.H * S.speed * (m.fault ? 2 : 1) : 0;
    m.T += (heat - K * (m.T - AMB)) * dt + (S.rand() - .5) * 1.2 * dt;
    m.T = Math.min(120, Math.max(20, m.T));
    if (running && m.T > 95) {
      m.hot += dt;
      if (m.hot >= 5) { m.broken = true; m.on = false; m.hot = 0; S.brk++; S.on.log(`${m.name} BROKE DOWN at ${m.T.toFixed(0)} °C`); S.on.toast(`${m.name} broke down. Repair it: OFF, then hold Repair.`); if (S.mission === 2) { S.m3Start = S.t; S.m3Units = 0; } }
    } else m.hot = 0;
    if (running && !m.broken) {
      m.health = Math.max(0, m.health - wear(m.T) * dt);
      if (m.health <= 0) { m.broken = true; m.on = false; m.hot = 0; S.brk++; S.on.log(`${m.name} WORE OUT (health 0%)`); S.on.toast(`${m.name} wore out. Repair it: OFF, then hold Repair.`); if (S.mission === 2) { S.m3Start = S.t; S.m3Units = 0; } }
    }
    const f = forecast(S, m);
    if (f && f.kind !== 'ok' && f.t <= 20 && !m.warned) { m.warned = true; const what = f.kind === 'heat' ? 'overheat' : 'wear out'; S.on.log(`PREDICTION: ${m.name} will ${what} in ~${Math.ceil(f.t)} s`); S.on.toast(`Prediction: ${m.name} will ${what} in about ${Math.ceil(f.t)} s`); }
    if (!f || f.kind === 'ok') m.warned = false;
    if (m.on && !m.broken) { const u = RATE * S.speed * dt; S.out += u; if (S.mission === 2) S.m3Units += u; }
    // repair
    const holding = input && input.repair === i;
    if (holding) {
      if (m.on) { if (m.rep === 0) S.on.toast(`Switch ${m.name} OFF before repairing (safety lockout).`); m.rep = 0; }
      else { m.rep += dt; if (m.rep >= 3) { m.rep = 0; m.broken = false; m.fault = false; m.health = 100; m.T = Math.min(m.T, 40); S.on.log(`${m.name} repaired`); S.on.toast(`${m.name} repaired and ready`); } }
    } else m.rep = 0;
  });
  S.histAcc += dt; if (S.histAcc >= 1 - 1e-9) { S.histAcc = 0; S.m.forEach(m => { m.hist.push(m.T); if (m.hist.length > 60) m.hist.shift(); }); }
  missions(S, dt);
  if (S.t >= SHIFT) endShift(S);
}

// advance by real seconds (accumulates into fixed ticks); getInput() is read every tick
function advance(S, seconds, getInput) {
  if (S.over) return;
  S.acc += seconds;
  while (S.acc >= TICK - 1e-9 && !S.over) { S.acc -= TICK; tick(S, getInput ? getInput() : null); }
}

function missions(S, dt) {
  if (S.mission >= MISSIONS.length) { S.mProg = 1; return; }
  const all = S.m, k = S.mission; let p = 0;
  if (k === 0) { if (!all[2].on) { done(S); return; } p = 0; }
  else if (k === 1) { const ok = all.every(m => m.on && !m.broken && m.T < 70); S.mTimer = ok ? S.mTimer + dt : 0; p = S.mTimer / 60; if (S.mTimer >= 60 - 1e-9) { done(S); return; } }
  else if (k === 2) {
    if (S.t - S.m3Start >= 60) { if (S.m3Units < 600) { S.on.log(`Attempt: ${Math.round(S.m3Units)} units in 60 s. Try again.`); } S.m3Start = S.t; S.m3Units = 0; }
    p = S.m3Units / 600; if (S.m3Units >= 600) { done(S); return; }
  }
  else if (k === 3) { const ok = all.every(m => m.on && !m.broken && !m.fault) && S.speed >= 1; S.mTimer = ok ? S.mTimer + dt : 0; p = S.mTimer / 30; if (S.mTimer >= 30 - 1e-9) { done(S); return; } }
  S.mProg = Math.min(1, p);
}
function done(S) {
  S.on.log(`Mission ${S.mission + 1} complete`); S.on.toast(`Mission ${S.mission + 1} complete!`);
  S.mDone++; S.mission++; S.mTimer = 0; S.m3Start = S.t; S.m3Units = 0; S.mProg = S.mission >= MISSIONS.length ? 1 : 0;
  S.on.mission(S.mission);
}
function skipMission(S) { if (!S.over && S.mission < MISSIONS.length) done(S); }
function endShift(S) {
  if (S.over) return; S.over = true;
  S.on.log('Shift ended');
  S.on.end(S);
}
const score = S => scoreOf(S.out, S.mDone, S.brk);
const stats = S => ({ output: Math.round(S.out), breakdowns: S.brk, missions: S.mDone, t: Math.min(S.t, SHIFT) });

SF.sim = { SHIFT, AMB, K, RATE, TICK, DEF, MISSIONS, MAX_OUTPUT, rng, fresh, serialize, restore, wear, heatOf, steady, forecast, state, label,
  toggle, setSpeed, clampSpeed, breakMachine, coolantFault, schedule, tick, advance, skipMission, endShift, score, scoreOf, stats };
})(window.SF = window.SF || {});
