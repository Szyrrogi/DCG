// Sztuczna inteligencja przeciwników (Przygoda i trening).
// Działa na kopii stanu gry: dla każdego możliwego ruchu symuluje jego skutek,
// ocenia planszę i wybiera najlepszy ruch. Ruchy losowe (np. Jade Jade Jade) symuluje kilka razy.
'use strict';
const { GameError, BY_NAME, CITIES, MANA_COSTS, MANA_MAX } = require('./engine');

const WIN = 1e6;

// ---------- ocena stanu z punktu widzenia gracza `seat` ----------
function heroWorth(hp) { return hp + 0.9 * Math.min(Math.max(hp, 0), 15); }

const PASSIVE_BONUS = {
  HeroImmune: 7, DoubleBattlecry: 2, GainStatStartTurn: 2.5, GainStatEndTurn: 2.5, PlayDiscardedUnits: 1,
  SongsDiscounted: 1.5, BuffAtkOnSpellCast: 1, DrawOnDiscard: 1, BuffOnBattlecry: 1.5, AdjacentBuff: 1.5,
  ReviveOnce: 2.5, BuffEverywhereOnGirl: 0.5,
};

function unitWorth(g, pi, u, mine) {
  const d = BY_NAME[u.name];
  const atk = g.attackOf(pi, u), hp = Math.max(0, u.hp);
  if (hp <= 0) return 0;
  let v = 1.0 * atk + 0.85 * hp + 0.35 * Math.min(atk, hp) + 0.6;
  if (d.taunt || u.taunt) v += 1.2 + 0.15 * hp;
  v += 1.3 * (d.spellPower || 0);
  if (u.name === 'Olaf' && u.olafMode === 2 && g.players[pi].board.some(x => x.name === 'Agnieszka')) v += 2.5;
  if (d.passive === 'TwoAttacks') v += 0.8 * atk;
  if (d.passive === 'Lifesteal') v += 0.5 * atk;
  if (d.passive === 'AutoAttackEndTurn') v += 0.3 * atk;
  if (d.passive === 'DamageHeroOnAttack') v += 0.5 * atk;
  if (d.passive === 'DestroyAllStartTurn') v = 1 + 0.3 * hp;
  v += PASSIVE_BONUS[d.passive] || 0;
  if (d.turnsUntilDeath > 0) v *= Math.max(0.2, Math.min(1, (d.turnsUntilDeath - (u.turnsAlive || 0)) / 3));
  if (!mine && u.frozen) v -= 0.4 * atk;
  return Math.max(0.1, v);
}

function nextTurnDamage(g, attacker, defender) {
  // ile obrażeń w bohatera może zadać `attacker` w swojej następnej turze (przybliżenie)
  const A = g.players[attacker], D = g.players[defender];
  if (g.heroImmune(defender)) return 0;
  let dmg = 0;
  for (const u of A.board) {
    if (u.frozen && attacker !== g.current) continue;
    if (BY_NAME[u.name].passive === 'AutoAttackEndTurn') { dmg += g.attackOf(attacker, u) * 0.5; continue; }
    dmg += g.attackOf(attacker, u) * (BY_NAME[u.name].passive === 'TwoAttacks' ? 2 : 1);
  }
  const taunt = D.board.filter(u => BY_NAME[u.name].taunt || u.taunt).reduce((s, u) => s + Math.max(0, u.hp), 0);
  dmg = Math.max(0, dmg - taunt);
  return dmg * (D.juliiTurns > 0 ? 3 : 1);
}

function evaluate(g, seat) {
  const o = 1 - seat, P = g.players[seat], O = g.players[o];
  if (g.over) return g.winner === seat ? WIN : -WIN;
  let s = heroWorth(P.hp) - heroWorth(O.hp);
  const wipe = [P, O].some(x => x.board.some(u => BY_NAME[u.name].passive === 'DestroyAllStartTurn'));
  const k = wipe ? 0.45 : 1;
  for (const u of P.board) s += unitWorth(g, seat, u, true) * k;
  for (const u of O.board) s -= unitWorth(g, o, u, false) * 1.12 * k;
  s += 1.6 * Math.min(P.hand.length, 8) - 0.8 * Math.min(O.hand.length, 8);
  if (P.deck.length === 0) s -= 3 + P.fatigue;
  for (const c of CITIES) {
    s += 1.1 * P.mana[c].lvl + 0.35 * P.mana[c].prog;
    s -= 0.5 * O.mana[c].lvl;
  }
  if (P.juliiTurns > 0) s -= 1.5 * P.juliiTurns;
  // zagrożenie w następnej turze przeciwnika
  const threat = nextTurnDamage(g, o, seat);
  if (threat >= P.hp) s -= 60; else s -= 0.25 * threat;
  // nasz potencjalny cios w następnej turze
  const pressure = nextTurnDamage(g, seat, o);
  if (pressure >= O.hp) s += 12; else s += 0.15 * pressure;
  if (g.heroImmune(seat)) s += 2;
  return s;
}

// ---------- ruchy ----------
// pozycja ma znaczenie tylko przy Rowerze (bonus dla sąsiadów)
function wantsPosition(g, seat, d) {
  const b = g.players[seat].board;
  return b.length > 0 && (d.passive === 'AdjacentBuff' || b.some(u => BY_NAME[u.name].passive === 'AdjacentBuff'));
}
function legalMoves(g, seat) {
  const v = g.view(seat), o = 1 - seat, moves = [];
  for (const c of v.me.hand) {
    if (!c.playable) continue;
    const d = BY_NAME[c.name];
    if (d.target === 'enemyAny') {
      moves.push({ type: 'play', uid: c.uid, target: 'hero' });
      for (const u of g.players[o].board) moves.push({ type: 'play', uid: c.uid, target: u.uid });
    } else if (d.target === 'enemyUnit') {
      if (!g.players[o].board.length) { if (d.type === 'unit') moves.push({ type: 'play', uid: c.uid }); continue; }
      for (const u of g.players[o].board) moves.push({ type: 'play', uid: c.uid, target: u.uid });
    } else if (d.type === 'unit' && wantsPosition(g, seat, d)) {
      for (let pos = 0; pos <= g.players[seat].board.length; pos++) moves.push({ type: 'play', uid: c.uid, pos });
    } else moves.push({ type: 'play', uid: c.uid });
  }
  const taunts = g.players[o].board.filter(u => BY_NAME[u.name].taunt || u.taunt);
  for (const u of v.me.board) {
    if (!u.canAttack) continue;
    const targets = taunts.length ? taunts.map(t => t.uid) : ['hero', ...g.players[o].board.map(t => t.uid)];
    for (const t of targets) moves.push({ type: 'attack', uid: u.uid, target: t });
  }
  return moves;
}

function pendingMoves(g, seat) {
  const q = g.pending; if (!q || q.player !== seat) return [];
  if (q.type === 'discard') return g.players[seat].hand.map(c => ({ type: 'choose', uid: c.uid }));
  if (q.type === 'target') return q.options.map(uid => ({ type: 'choose', uid }));
  if (q.type === 'choice') return q.options.map((_, index) => ({ type: 'choiceIndex', index }));
  return [];
}

const RANDOM_EFFECTS = new Set(['DamageRandomEnemy3Times', 'ChanceBuff', 'SummonRandomUnit', 'AddRandomSpellToHand', 'ReturnToHandRandom', 'ReturnFriendlyToHand', 'OpponentDiscardsCard', 'DrawCards', 'DiscardAndDraw2', 'Draw5Spells', 'BothPlayersDraw2', 'HalveAttack3Random', 'ResurrectFriendlyUnit', 'DestroyAndOpponentDraws']);
function isRandom(g, seat, m) {
  if (m.type !== 'play') return false;
  const c = g.players[seat].hand.find(x => x.uid === m.uid);
  return c && RANDOM_EFFECTS.has(BY_NAME[c.name].effect);
}

// rozwiązuje własne wybory w symulacji najlepszą opcją (płytko)
function settle(g, seat, depth) {
  let guard = 0;
  while (g.pending && g.pending.player === seat && !g.over && guard++ < 6) {
    const ms = pendingMoves(g, seat);
    if (!ms.length) break;
    let best = null, bestS = -Infinity;
    for (const m of ms) {
      const c = g.clone();
      try { c.action(seat, m); } catch (e) { if (e instanceof GameError) continue; throw e; }
      const sc = depth > 0 ? (settle(c, seat, depth - 1), evaluate(c, seat)) : evaluate(c, seat);
      if (sc > bestS) { bestS = sc; best = m; }
    }
    if (!best) break;
    g.action(seat, best);
  }
}

function simulate(g, seat, m, samples = 1) {
  let total = 0, n = 0;
  for (let k = 0; k < samples; k++) {
    const c = g.clone();
    try { c.action(seat, m); } catch (e) { if (e instanceof GameError) return -Infinity; throw e; }
    settle(c, seat, 1);
    total += evaluate(c, seat); n++;
  }
  return total / n;
}

function bestMove(g, seat, moves) {
  let best = null, bestS = -Infinity;
  for (const m of moves) {
    const sc = simulate(g, seat, m, isRandom(g, seat, m) ? 3 : 1);
    if (sc > bestS) { bestS = sc; best = m; }
  }
  return { move: best, score: bestS };
}

// ---------- rozbudowa miast ----------
function cityDemand(g, seat, c) {
  const P = g.players[seat], lvl = P.mana[c].lvl;
  let d = 0;
  for (const x of P.hand) { const need = BY_NAME[x.name].cost[c]; if (need > lvl) d += 2.5 / (need - lvl); }
  for (const x of P.deck) { const need = BY_NAME[x.name].cost[c]; if (need > lvl) d += 1 / (need - lvl); }
  return d;
}
function chooseManaBuild(g, seat) {
  const P = g.players[seat];
  if (P.manaActionUsed) return null;
  const options = CITIES.filter(c => P.mana[c].lvl < MANA_MAX);
  if (!options.length) return null;
  let best = null, bestS = -Infinity;
  for (const c of options) {
    const sim = g.clone();
    try { sim.action(seat, { type: 'mana', city: c }); } catch (e) { continue; }
    const follow = bestMove(sim, seat, legalMoves(sim, seat));
    const gain = Math.max(evaluate(sim, seat), follow.score === -Infinity ? -Infinity : follow.score);
    const m = P.mana[c];
    const willLevel = m.prog + 1 >= MANA_COSTS[m.lvl];
    const sc = gain + 1.2 * cityDemand(g, seat, c) + (willLevel ? 0.5 : 0) - 0.15 * m.lvl;
    if (sc > bestS) { bestS = sc; best = c; }
  }
  return best && { type: 'mana', city: best };
}

// ---------- wymiana startowa ----------
function mulliganPick(g, seat) {
  const P = g.players[seat];
  const out = [];
  for (const c of P.hand) {
    const d = BY_NAME[c.name], cost = d.cost;
    const city = Math.max(...CITIES.map(k => cost[k] - P.mana[k].lvl));
    const total = cost.T + cost.W + cost.B + cost.D - CITIES.reduce((s, k) => s + Math.min(cost[k], P.mana[k].lvl), 0);
    if (city >= 3 || total >= 5) out.push(c.uid);
  }
  return out;
}

// ---------- główna decyzja ----------
function decide(g, seat) {
  if (g.over) return null;
  if (g.phase === 'mulligan') return g.mulliganDone[seat] ? null : { type: 'mulligan', uids: mulliganPick(g, seat) };
  if (g.pending) {
    if (g.pending.player !== seat) return null;
    const ms = pendingMoves(g, seat);
    return ms.length ? bestMove(g, seat, ms).move : null;
  }
  if (g.current !== seat) return null;
  const mana = chooseManaBuild(g, seat);
  if (mana) return mana;
  const base = evaluate(g, seat);
  const { move, score } = bestMove(g, seat, legalMoves(g, seat));
  if (move && score > base + 0.05) return move;
  return { type: 'end' };
}

module.exports = { decide, evaluate };
