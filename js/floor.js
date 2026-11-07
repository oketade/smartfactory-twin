/* Plant floor drawing (SVG). Same three clickable stations as 1.0, drawn as recognisable machines:
   a hydraulic press, a saw cutter and an oven, each with a beacon lamp, analogue gauge, digital
   readout and health bar, feeding a moving conveyor. */
(function (SF) {
'use strict';
const ns = 'http://www.w3.org/2000/svg';
const COL = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', off: 'var(--muted)' };
const RAW = { ok: '#3ccf7a', warn: '#f2b632', bad: '#ff5a5a', off: '#8aa0bd' };
let svg, els = [], boxes = [], puffs = [], rot = 0, phase = 0, beltOff = 0, boxOff = 0;
const $ = id => svg.querySelector('#' + id);

function defs() {
  return `<defs>
    <linearGradient id="gWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1322"/><stop offset="1" stop-color="#0e1a2d"/></linearGradient>
    <linearGradient id="gFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101d31"/><stop offset="1" stop-color="#0a1424"/></linearGradient>
    <linearGradient id="gHousing" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2b45"/><stop offset=".5" stop-color="#14233a"/><stop offset="1" stop-color="#0f1b2e"/></linearGradient>
    <linearGradient id="gSteel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4a5d78"/><stop offset=".5" stop-color="#8396b1"/><stop offset="1" stop-color="#3d4e66"/></linearGradient>
    <linearGradient id="gOvenWin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#d9480f"/></linearGradient>
    <radialGradient id="gGlow"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <pattern id="pHaz" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="14" fill="#f2b632" opacity=".55"/></pattern>
    <pattern id="pVent" width="6" height="4" patternUnits="userSpaceOnUse"><rect width="6" height="1.6" fill="#0a1220"/></pattern>
  </defs>`;
}

function hall() {
  let grid = '';
  for (let i = 0; i <= 12; i++) { const x = i * 50; grid += `<line x1="${300 + (x - 300) * .55}" y1="250" x2="${300 + (x - 300) * 1.25}" y2="330" stroke="#16263f" stroke-width="1"/>`; }
  [262, 284, 310].forEach(y => grid += `<line x1="0" y1="${y}" x2="600" y2="${y}" stroke="#16263f"/>`);
  let pipes = `<rect x="0" y="6" width="600" height="7" rx="3" fill="#1b2c47"/><rect x="0" y="16" width="600" height="3" fill="#15233a"/>`;
  for (let x = 40; x < 600; x += 110) pipes += `<rect x="${x}" y="4" width="6" height="16" rx="1" fill="#2a3f60"/>`;
  return `<rect x="0" y="0" width="600" height="250" fill="url(#gWall)"/>
    <rect x="0" y="250" width="600" height="80" fill="url(#gFloor)"/>${grid}${pipes}
    <rect x="0" y="244" width="600" height="6" fill="url(#pHaz)"/>
    <text x="586" y="36" text-anchor="end" fill="#2b4468" font-family="Chakra Petch, Arial" font-weight="700" font-size="13" letter-spacing="3">HALL A</text>`;
}

// machine-specific mechanism inside the window (x0..x0+130, y 64..170)
function mech(i, x) {
  const cx = x + 85;
  if (i === 0) { // hydraulic press
    return `<rect x="${x + 36}" y="66" width="10" height="104" fill="url(#gSteel)"/><rect x="${x + 124}" y="66" width="10" height="104" fill="url(#gSteel)"/>
      <rect x="${x + 30}" y="62" width="110" height="14" rx="2" fill="#2d4262"/>
      <rect x="${cx - 6}" y="76" width="12" height="18" fill="#56698a"/>
      <g id="rotor0"><rect x="${cx - 6}" y="76" width="12" height="40" fill="url(#gSteel)"/><rect x="${x + 50}" y="112" width="70" height="14" rx="2" fill="#6b7f9e"/></g>
      <rect x="${x + 48}" y="150" width="74" height="8" fill="#e6eef9" opacity=".18"/>
      <rect x="${x + 30}" y="158" width="110" height="12" rx="2" fill="#2d4262"/>`;
  }
  if (i === 1) { // saw cutter
    let teeth = '';
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, a2 = a + .2; const r1 = 34, r2 = 41;
      teeth += `${k ? 'L' : 'M'}${(cx + Math.cos(a) * r1).toFixed(1)},${(116 + Math.sin(a) * r1).toFixed(1)} L${(cx + Math.cos(a2) * r2).toFixed(1)},${(116 + Math.sin(a2) * r2).toFixed(1)} `; }
    return `<rect x="${x + 22}" y="150" width="126" height="18" rx="2" fill="#2d4262"/>
      <g id="rotor1" style="transform-origin:${cx}px 116px"><path d="${teeth}Z" fill="url(#gSteel)"/><circle cx="${cx}" cy="116" r="30" fill="#5a6d8c"/>
        <circle cx="${cx}" cy="116" r="7" fill="#0a1220"/><rect x="${cx - 2}" y="90" width="4" height="52" fill="#3d4e66"/><rect x="${cx - 26}" y="114" width="52" height="4" fill="#3d4e66"/></g>
      <path d="M${x + 30} 80 h110 v14 h-20 v-6 h-70 v6 h-20z" fill="#2d4262" opacity=".9"/>
      <circle id="coolant1" cx="${x + 34}" cy="140" r="5" fill="#2fd3f5"/>`;
  }
  // oven
  return `<rect x="${x + 26}" y="64" width="118" height="104" rx="6" fill="#2a2122" stroke="#4a3a3a"/>
    <rect id="ovenWin" x="${x + 40}" y="80" width="90" height="56" rx="4" fill="url(#gOvenWin)" opacity=".3"/>
    <g opacity=".35" stroke="#1a1010" stroke-width="2">${[0, 1, 2, 3].map(k => `<line x1="${x + 40}" y1="${88 + k * 13}" x2="${x + 130}" y2="${88 + k * 13}"/>`).join('')}</g>
    <rect x="${x + 64}" y="144" width="42" height="6" rx="3" fill="url(#gSteel)"/>
    <g id="rotor2" style="transform-origin:${x + 132}px 156px"><rect x="${x + 130}" y="148" width="4" height="16" fill="#8396b1"/><rect x="${x + 124}" y="154" width="16" height="4" fill="#8396b1"/></g>`;
}

function build(target, onSelect) {
  svg = target; els = [];
  svg.innerHTML = defs() + hall() +
    `<g id="smoke"></g>
     <line x1="16" y1="282" x2="584" y2="282" stroke="#1f3150" stroke-width="20" stroke-linecap="round"/>
     <line id="dash" x1="16" y1="282" x2="584" y2="282" stroke="#2b4468" stroke-width="20" stroke-dasharray="6 18"/>
     <g id="rollers">${Array.from({ length: 24 }, (_, k) => `<circle cx="${24 + k * 24}" cy="282" r="3" fill="#0a1220"/>`).join('')}</g>
     <g id="boxes"></g>
     <text x="16" y="318" fill="var(--muted)" font-family="IBM Plex Mono, monospace" font-size="11">CONVEYOR → PACKING</text>
     <text id="tput" x="584" y="318" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono, monospace" font-size="11"></text>`;
  // oven chimney behind its housing
  const ox = 25 + 2 * 190;
  svg.insertAdjacentHTML('beforeend', `<rect x="${ox + 120}" y="14" width="22" height="16" fill="#24364f"/><rect x="${ox + 116}" y="11" width="30" height="5" fill="#2d4262"/>`);
  SF.sim.DEF.forEach((d, i) => {
    const x = 25 + i * 190, g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'station'); g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `Select ${d.name}`); g.dataset.i = i;
    g.innerHTML = `<rect x="${x + 6}" y="238" width="158" height="8" rx="3" fill="#000" opacity=".35"/>
      <rect class="frame" x="${x}" y="26" width="170" height="214" rx="9"/>
      <rect x="${x + 1}" y="27" width="168" height="26" rx="8" fill="#0f1b2e"/>
      <text x="${x + 12}" y="45" fill="var(--fg)" font-family="Chakra Petch, Arial" font-weight="600" font-size="16">${d.name}</text>
      <circle id="halo${i}" cx="${x + 152}" cy="40" r="14" fill="url(#gGlow)" opacity="0"/>
      <circle id="lamp${i}" cx="${x + 152}" cy="40" r="6.5" fill="var(--ok)" stroke="#0a1220" stroke-width="1.5"/>
      <rect x="${x + 18}" y="58" width="134" height="116" rx="6" fill="#0a1220" stroke="var(--line)"/>
      <rect id="core${i}" x="${x + 19}" y="59" width="132" height="114" rx="6" fill="var(--ok)" opacity=".12"/>
      ${mech(i, x)}
      <text id="ftxt${i}" x="${x + 85}" y="122" text-anchor="middle" fill="#fff" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="15" stroke="#0a1220" stroke-width="3" paint-order="stroke"></text>
      <rect x="${x + 10}" y="180" width="6" height="52" fill="url(#pVent)"/><rect x="${x + 154}" y="180" width="6" height="52" fill="url(#pVent)"/>
      <path d="M${x + 22} 214 a22 22 0 0 1 44 0" fill="none" stroke="#1f3150" stroke-width="5"/>
      <path d="M${x + 22} 214 a22 22 0 0 1 22 -22" fill="none" stroke="var(--ok)" stroke-width="5" opacity=".55"/>
      <path d="M${x + 44} 192 a22 22 0 0 1 15.6 6.4" fill="none" stroke="var(--warn)" stroke-width="5" opacity=".55"/>
      <path d="M${x + 59.6} 198.4 a22 22 0 0 1 6.4 15.6" fill="none" stroke="var(--bad)" stroke-width="5" opacity=".55"/>
      <line id="needle${i}" x1="${x + 44}" y1="214" x2="${x + 44}" y2="196" stroke="var(--fg)" stroke-width="2.5" stroke-linecap="round" style="transform-origin:${x + 44}px 214px"/>
      <circle cx="${x + 44}" cy="214" r="3" fill="var(--fg)"/>
      <rect x="${x + 76}" y="186" width="80" height="30" rx="4" fill="#06101c" stroke="var(--line)"/>
      <text id="ttxt${i}" x="${x + 150}" y="208" text-anchor="end" fill="var(--fg)" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="17">--</text>
      <text x="${x + 22}" y="232" fill="var(--muted)" font-family="IBM Plex Mono, monospace" font-size="8.5">HEALTH</text>
      <rect x="${x + 60}" y="225" width="96" height="7" rx="3" fill="#0a1220" stroke="var(--line)"/>
      <rect id="fhb${i}" x="${x + 60}" y="225" width="96" height="7" rx="3" fill="var(--ok)"/>
      <rect x="${x + 72}" y="240" width="26" height="30" fill="#1b2c47"/><rect x="${x + 68}" y="266" width="34" height="5" fill="#2a3f60"/>`;
    g.addEventListener('click', () => onSelect(i));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } });
    svg.appendChild(g);
    els.push({ g, lamp: $('lamp' + i), halo: $('halo' + i), core: $('core' + i), ftxt: $('ftxt' + i), ttxt: $('ttxt' + i), fhb: $('fhb' + i), needle: $('needle' + i), rotor: $('rotor' + i) });
  });
  boxes = [];
  const bg = $('boxes');
  for (let k = 0; k < 7; k++) {
    const b = document.createElementNS(ns, 'g');
    b.innerHTML = `<rect x="-9" y="-9" width="18" height="14" rx="1.5" fill="#b0834f" stroke="#6e4e2a"/><rect x="-1.5" y="-9" width="3" height="14" fill="#d9b27c" opacity=".7"/>`;
    bg.appendChild(b); boxes.push(b);
  }
  puffs = [];
  const sg = $('smoke');
  for (let k = 0; k < 4; k++) { const c = document.createElementNS(ns, 'circle'); c.setAttribute('r', '6'); c.setAttribute('fill', '#8aa0bd'); c.setAttribute('opacity', '0'); sg.appendChild(c); puffs.push({ c, p: k / 4 }); }
}

function update(S, sel) {
  S.m.forEach((m, i) => {
    const e = els[i], s = SF.sim.state(m), col = COL[s];
    const blink = s === 'bad' && Math.floor(S.t * 2) % 2;
    e.lamp.setAttribute('fill', col);
    e.halo.setAttribute('fill', RAW[s]); e.halo.setAttribute('opacity', s === 'off' ? '0' : blink ? '.15' : '.35');
    e.core.setAttribute('fill', s === 'off' ? '#22334d' : col);
    e.core.setAttribute('opacity', s === 'bad' ? (blink ? '.32' : '.16') : '.12');
    e.ttxt.textContent = m.T.toFixed(1) + ' °C';
    e.ttxt.setAttribute('fill', s === 'bad' ? 'var(--bad)' : s === 'warn' ? 'var(--warn)' : 'var(--fg)');
    e.ftxt.textContent = m.broken ? 'FAULT' : m.fault ? 'COOLANT' : '';
    const ang = (Math.min(120, Math.max(20, m.T)) - 20) / 100 * 180 - 90;
    e.needle.style.transform = `rotate(${ang}deg)`;
    const hc = m.health < 30 ? 'var(--bad)' : m.health < 60 ? 'var(--warn)' : 'var(--ok)';
    e.fhb.setAttribute('width', (96 * m.health / 100).toFixed(1)); e.fhb.setAttribute('fill', hc);
    e.g.classList.toggle('sel', sel === i);
  });
  // oven window glows with temperature; Cutter B coolant lamp turns red on a fault
  const ov = S.m[2], w = $('ovenWin');
  w.setAttribute('opacity', (ov.on && !ov.broken ? 0.25 + Math.min(1, Math.max(0, (ov.T - 40) / 60)) * 0.7 : 0.12).toFixed(2));
  $('coolant1').setAttribute('fill', S.m[1].fault ? 'var(--bad)' : 'var(--accent)');
  const running = S.m.filter(m => m.on && !m.broken).length;
  $('tput').textContent = `${(running * SF.sim.RATE * S.speed).toFixed(1)} units/s`;
}

// motion: called every animation frame while the shift runs
function animate(S, dt) {
  const k = dt * 60;
  rot += 6 * S.speed * k; phase += 0.12 * S.speed * k;
  S.m.forEach((m, i) => {
    const r = els[i].rotor; if (!r) return;
    const run = m.on && !m.broken;
    if (i === 0) r.setAttribute('transform', run ? `translate(0 ${(Math.max(0, Math.sin(phase)) * 24).toFixed(1)})` : '');
    else r.style.transform = run ? `rotate(${rot * (1 + i * .3)}deg)` : '';
  });
  const running = S.m.filter(m => m.on && !m.broken).length;
  const v = running ? S.speed * (0.6 + running * 0.25) * k : 0;
  beltOff -= 1.2 * v; boxOff += 1.2 * v;
  $('dash').style.strokeDashoffset = beltOff;
  boxes.forEach((b, j) => { const x = 20 + ((boxOff + j * 84) % 588); b.setAttribute('transform', `translate(${x.toFixed(1)} 280)`); });
  const ov = S.m[2], ox = 25 + 2 * 190 + 131;
  puffs.forEach(p => {
    p.p = (p.p + 0.006 * k) % 1;
    const on = ov.on && !ov.broken;
    p.c.setAttribute('cx', (ox + Math.sin(p.p * 6 + rot * .01) * 6).toFixed(1));
    p.c.setAttribute('cy', (10 - p.p * 18).toFixed(1));
    p.c.setAttribute('r', (4 + p.p * 7).toFixed(1));
    p.c.setAttribute('opacity', on ? ((1 - p.p) * 0.25).toFixed(2) : '0');
  });
}

SF.floor = { build, update, animate };
})(window.SF = window.SF || {});
