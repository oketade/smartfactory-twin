/* Simulated players (mock mode only).
   A bot runs the real simulation engine with the competition seed and plays it with a
   simple policy. Skill (0..1) controls reaction time, how carefully it picks a speed and
   how often it ignores warnings, so the class leaderboard shows a realistic spread.
   Bots are always flagged `simulated: true` and shown with a SIM badge. */
(function (SF) {
'use strict';
const sim = SF.sim;

function createBot(seed, skill, personalSeed) {
  const S = sim.fresh(seed);
  const r = sim.rng(personalSeed);          // the bot's own decisions, separate from the shared world noise
  const bot = { S, skill, r, repair: -1, nextThink: 1 + r() * 3 };
  return bot;
}

// best speed whose steady temperature keeps every running machine under `limit`
function pickSpeed(S, limit) {
  let best = 0.5;
  for (let s = 0.5; s <= 2.0001; s += 0.1) {
    const ok = S.m.every(m => !m.on || m.broken || sim.steady(m, s) < limit);
    if (ok) best = s;
  }
  return sim.clampSpeed(best);
}

function think(bot) {
  const { S, skill, r } = bot;
  const careless = r() > skill;              // this decision ignores warnings
  // keep repairing until done
  if (bot.repair >= 0) {
    const m = S.m[bot.repair];
    if (!m.broken && !m.fault && m.health > 99) bot.repair = -1;
    else return;
  }
  for (let i = 0; i < S.m.length; i++) {
    const m = S.m[i];
    if (m.broken) { bot.repair = i; return; }
    // good operators fix coolant faults and worn machines proactively
    if (m.on && (m.fault || m.health < 25) && !careless) { sim.toggle(S, i); bot.repair = i; return; }
    const f = sim.forecast(S, m);
    if (m.on && f && f.kind !== 'ok' && f.t < 12 + skill * 15 && !careless) { sim.toggle(S, i); return; }
    if (m.on && m.T > 85 && !careless) { sim.toggle(S, i); return; }
    if (!m.on && !m.broken && m.T < 60 - skill * 10) { sim.toggle(S, i); return; }
  }
  // speed: mission 2 (output) pushes harder, mission 1 needs everything under 70 °C
  let limit = S.mission === 1 ? 68 : S.mission === 2 ? 84 : S.mission === 3 ? 80 : 82;
  if (careless) limit += 6 + r() * 10;      // reckless choice
  let target = pickSpeed(S, limit);
  if (S.mission === 3 && target < 1 && skill > 0.5) target = 1.0;
  if (Math.abs(target - S.speed) > 0.05) sim.setSpeed(S, S.speed + Math.sign(target - S.speed) * (careless ? 0.3 : 0.1));
}

// advance a bot to shift time `t` (seconds)
function advanceTo(bot, t) {
  const S = bot.S;
  while (!S.over && S.t + sim.TICK <= t + 1e-9) {
    if (S.t >= bot.nextThink) {
      think(bot);
      // reaction time: 0.6 s (sharp) .. 4.5 s (slow), plus jitter
      bot.nextThink = S.t + 0.6 + (1 - bot.skill) * 3.9 * (0.5 + bot.r());
    }
    sim.tick(S, { repair: bot.repair });
  }
}

SF.bot = { createBot, advanceTo };
})(window.SF = window.SF || {});
