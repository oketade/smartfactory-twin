/* Rosters, live leaderboards, podiums and the winner announcement.
   All names are inserted with textContent (never innerHTML) because they are typed by students. */
(function (SF) {
'use strict';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return el;
}
const simTag = () => h('span', { class: 'simtag', title: 'Simulated player (mock data, not a real student)', text: 'SIM' });
const teamTag = t => t ? h('span', { class: 'teamtag', style: `--tc:${t.color}`, text: t.name }) : null;
const teamMap = snap => Object.fromEntries((snap.teams || []).map(t => [t.id, t]));
const fmtN = n => Number(n).toLocaleString('en-US');
function shortName(name) { return name.length > 22 ? name.slice(0, 21) + '…' : name; }

// ---------- lobby roster (grouped by team when teams exist)
function roster(el, snap, opts) {
  opts = opts || {};
  el.replaceChildren();
  const ps = [...snap.players].sort((a, b) => a.simulated - b.simulated || a.name.localeCompare(b.name));
  if (!ps.length) { el.append(h('p', { class: 'empty', text: opts.emptyText || 'Nobody has joined yet. Share the code on the projector.' })); return; }
  const chip = p => h('div', { class: 'who' + (p.id === opts.meId ? ' me' : ''), title: p.online ? 'Connected' : 'Not connected' },
    h('span', { class: 'dot' + (p.online ? ' on' : ''), 'aria-label': p.online ? 'connected' : 'not connected' }),
    h('span', { class: 'nm', text: p.name + (p.id === opts.meId ? ' (you)' : '') }),
    p.simulated ? simTag() : null,
    opts.onKick && !p.simulated ? h('button', { class: 'x', 'aria-label': 'Remove ' + p.name, title: 'Remove from competition', text: '×', onclick: () => opts.onKick(p) }) : null);
  if (snap.teams && snap.teams.length) {
    const tm = teamMap(snap);
    [...snap.teams].sort((a, b) => a.name.localeCompare(b.name)).forEach(t => {
      const members = ps.filter(p => p.team_id === t.id);
      el.append(h('div', { class: 'team-group', style: `border-color:${t.color}55` },
        h('h3', null, teamTag(t), h('span', { class: 'lbl', text: members.length + ' members' })),
        h('div', { class: 'roster' }, members.map(chip))));
    });
    const loose = ps.filter(p => !tm[p.team_id]);
    if (loose.length) el.append(h('div', { class: 'team-group' }, h('h3', null, h('span', { class: 'lbl', text: 'Not yet assigned' })), h('div', { class: 'roster' }, loose.map(chip))));
  } else ps.forEach(p => el.append(chip(p)));
}

// ---------- podium: entries [{name, score, simulated, sub, members}] in rank order
function podium(entries, opts) {
  opts = opts || {};
  const order = [1, 0, 2]; // silver, gold, bronze
  const wrap = h('div', { class: 'podium' + (opts.live ? ' live-pod' : '') });
  order.forEach(idx => {
    const e = entries[idx], place = idx + 1;
    if (!e) { wrap.append(h('div', { class: `pod p${place} empty` }, h('div', { class: 'who-name', text: '—' }), h('div', { class: 'block', text: place }))); return; }
    wrap.append(h('div', { class: `pod p${place}`, 'data-place': place },
      opts.live ? null : h('div', { class: 'medal', text: place }),
      h('div', { class: 'who-name', title: e.name }, shortName(e.name), e.simulated ? [' ', simTag()] : null),
      h('div', { class: 'who-score num', text: fmtN(e.score) + (opts.unit || ' pts') }),
      e.sub ? h('div', { class: 'members', text: e.sub }) : null,
      h('div', { class: 'block', text: ['1st', '2nd', '3rd'][idx] })));
  });
  return wrap;
}

function playerEntries(snap) { const tm = teamMap(snap); return snap.players.map(p => ({ ...p, sub: tm[p.team_id] ? tm[p.team_id].name : '' })); }
function teamEntries(snap) {
  return snap.teams.map(t => {
    const ms = snap.players.filter(p => p.team_id === t.id).sort((a, b) => b.score - a.score);
    return { ...t, score: t.avg, members: ms, sub: ms.map(m => m.name).join(', ') };
  });
}

// ---------- tables
function playerTable(snap, opts) {
  const tm = teamMap(snap), live = opts.live;
  let rows = snap.players;
  if (opts.limit && rows.length > opts.limit) {
    const top = rows.slice(0, opts.limit), me = rows.find(p => p.id === opts.meId);
    rows = me && !top.includes(me) ? [...top, me] : top;
  }
  const tb = h('tbody');
  if (!rows.length) tb.append(h('tr', null, h('td', { class: 'empty', colspan: 7, text: 'No players yet.' })));
  rows.forEach(p => tb.append(h('tr', { class: (p.rank === 1 ? 'top1 ' : '') + (p.id === opts.meId ? 'me' : '') },
    h('td', { class: 'n', text: p.rank }),
    h('td', null, p.name, p.simulated ? simTag() : null, tm[p.team_id] && !opts.hideTeam ? [' ', teamTag(tm[p.team_id])] : null),
    h('td', { class: 'n', text: fmtN(p.output) }),
    h('td', { class: 'n', text: p.missions + '/4' }),
    h('td', { class: 'n', text: p.breakdowns }),
    h('td', { class: 'n', text: fmtN(p.score) }),
    h('td', null, p.final ? h('span', { class: 'final-ok', text: 'FINAL' }) : p.has_result ? h('span', { class: 'pending', text: live ? 'LIVE' : 'PROVISIONAL' }) : h('span', { class: 'pending', text: 'NO DATA' })))));
  return h('div', { class: 'tbl' }, h('table', null,
    h('thead', null, h('tr', null, h('th', { class: 'n', text: '#' }), h('th', { text: 'Operator' }), h('th', { class: 'n', text: 'Output' }),
      h('th', { class: 'n', text: 'Missions' }), h('th', { class: 'n', text: 'Breakdowns' }), h('th', { class: 'n', text: 'Score' }), h('th', { text: '' }))), tb));
}
function teamTable(snap, opts) {
  const tb = h('tbody');
  const ts = teamEntries(snap);
  if (!ts.length) tb.append(h('tr', null, h('td', { class: 'empty', colspan: 5, text: 'Teams are assigned when the host starts the competition.' })));
  ts.forEach(t => tb.append(h('tr', { class: (t.rank === 1 ? 'top1 ' : '') + (t.members.some(m => m.id === opts.meId) ? 'me' : '') },
    h('td', { class: 'n', text: t.rank }),
    h('td', null, teamTag(t)),
    h('td', null, h('div', { class: 'contrib' }, t.members.map(m => h('span', null, h('b', null, m.name, m.simulated ? simTag() : null), ' ' + fmtN(m.score))))),
    h('td', { class: 'n', text: fmtN(t.avg) }),
    h('td', { class: 'n', text: fmtN(t.total) }))));
  return h('div', { class: 'tbl' }, h('table', null,
    h('thead', null, h('tr', null, h('th', { class: 'n', text: '#' }), h('th', { text: 'Team' }), h('th', { text: 'Member contributions' }),
      h('th', { class: 'n', text: 'Average' }), h('th', { class: 'n', text: 'Total' }))), tb));
}

// ---------- live leaderboard (podium + table)
function live(el, snap, opts) {
  opts = opts || {};
  const view = opts.view === 'teams' && snap.teams.length ? 'teams' : 'players';
  const entries = view === 'teams' ? teamEntries(snap) : playerEntries(snap);
  el.replaceChildren(
    opts.noPodium ? '' : podium(entries.slice(0, 3), { live: true, unit: view === 'teams' ? ' avg' : ' pts' }),
    view === 'teams' ? teamTable(snap, opts) : playerTable(snap, { ...opts, live: true }));
}

// ---------- winner announcement
let revealTimers = [];
function results(snap, opts) {
  opts = opts || {};
  revealTimers.forEach(clearTimeout); revealTimers = [];
  const isTeam = snap.comp.mode === 'team' && snap.teams.length;
  const entries = isTeam ? teamEntries(snap) : playerEntries(snap);
  const $ = id => document.getElementById(id);
  $('rsKicker').textContent = `Competition ${snap.comp.code} · final results`;
  $('rsTitle').replaceChildren(isTeam ? 'Winning ' : 'Shift ', h('span', { text: isTeam ? 'teams' : 'champions' }));
  const nReal = snap.players.filter(p => !p.simulated).length, nSim = snap.players.length - nReal;
  $('rsSub').textContent = `${snap.players.length} operators` + (nSim ? ` (${nReal} real, ${nSim} simulated)` : '') +
    (isTeam ? ` in ${snap.teams.length} teams · teams ranked by average member score` : ' · ranked by score');
  const pod = podium(entries.slice(0, 3), { unit: isTeam ? ' avg' : ' pts' });
  $('rsPodium').replaceWith(pod); pod.id = 'rsPodium';
  const me = snap.players.find(p => p.id === opts.meId);
  const you = $('rsYou');
  if (me) {
    let txt = `You finished #${me.rank} of ${snap.players.length} with ${fmtN(me.score)} points`;
    if (isTeam) { const t = entries.find(t => t.members.some(m => m.id === me.id)); if (t) txt += ` · ${t.name} placed #${t.rank}`; }
    you.textContent = txt; you.hidden = false;
  } else you.hidden = true;
  $('rsTableTitle').textContent = isTeam ? 'Team ranking' : 'Full ranking';
  $('rsTableLbl').textContent = isTeam ? 'Average · total · individual contributions' : 'Score = output + level bonus + 150 × missions − 200 × breakdowns';
  const tbl = $('rsTable');
  tbl.replaceChildren(isTeam ? teamTable(snap, opts) : playerTable(snap, opts));
  if (isTeam) tbl.append(h('h3', { style: 'margin:14px 0 4px;font-size:15px', text: 'Individual ranking' }), playerTable(snap, opts));
  const card = $('rsTableCard'); card.classList.remove('show');
  // reveal 3rd → 2nd → 1st
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pods = { 3: pod.querySelector('.p3'), 2: pod.querySelector('.p2'), 1: pod.querySelector('.p1') };
  const steps = reduce ? [[0, 3], [0, 2], [0, 1]] : [[700, 3], [2100, 2], [3700, 1]];
  steps.forEach(([ms, place]) => revealTimers.push(setTimeout(() => {
    pods[place] && pods[place].classList.add('show');
    if (place === 1 && !reduce) confetti(4500);
  }, ms)));
  revealTimers.push(setTimeout(() => card.classList.add('show'), reduce ? 0 : 5200));
}

// ---------- confetti (canvas, stops by itself)
let confRaf = 0;
function confetti(ms) {
  const c = document.getElementById('confetti'), x = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cols = ['#f5c542', '#2fd3f5', '#3ccf7a', '#ff7a59', '#c9d3df', '#b48cff'];
  // falls from above the viewport so it never covers the winner's name
  const parts = Array.from({ length: 220 }, () => ({ x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * .6,
    vx: (Math.random() - .5) * 2, vy: 1 + Math.random() * 3, r: 3 + Math.random() * 5, a: Math.random() * 6, va: (Math.random() - .5) * .3,
    c: cols[Math.floor(Math.random() * cols.length)] }));
  const end = performance.now() + ms;
  cancelAnimationFrame(confRaf);
  const frame = now => {
    x.clearRect(0, 0, innerWidth, innerHeight);
    const fade = Math.max(0, Math.min(1, (end - now) / 800));
    parts.forEach(p => {
      p.vy = Math.min(p.vy + 0.05, 4.5); p.vx += Math.sin(p.a) * 0.05; p.x += p.vx; p.y += p.vy; p.a += p.va;
      x.save(); x.globalAlpha = fade; x.translate(p.x, p.y); x.rotate(p.a); x.fillStyle = p.c; x.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); x.restore();
    });
    if (now < end) confRaf = requestAnimationFrame(frame); else x.clearRect(0, 0, innerWidth, innerHeight);
  };
  confRaf = requestAnimationFrame(frame);
}

SF.board = { h, roster, live, results, confetti, simTag, teamTag };
})(window.SF = window.SF || {});
