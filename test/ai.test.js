// Test sztucznej inteligencji: bot gra poprawnie (bez wyjątków), szybko podejmuje decyzje
// i wyraźnie wygrywa z prostym graczem grającym tą samą talią.
'use strict';
const assert = require('assert');
const { Game, GameError, CARDS } = require('../server/engine');
const AI = require('../server/ai');
const { BOTS, botSeat } = require('../server/bots');

const POOL = CARDS.filter(c => !c.token && !c.hidden);
function deck() { const d = []; while (d.length < 20) { const c = POOL[Math.floor(Math.random() * POOL.length)]; if (d.filter(x => x === c.name).length < (c.rarity === 1 ? 3 : 1)) d.push(c.name); } return d; }
function naive(g, i) {
  const q = g.pending;
  if (q && q.player === i) { const p = g.players[i]; return q.type === 'discard' ? { type: 'choose', uid: p.hand[0].uid } : q.type === 'target' ? { type: 'choose', uid: q.options[0] } : { type: 'choiceIndex', index: 0 }; }
  if (g.phase === 'mulligan') return g.mulliganDone[i] ? null : { type: 'mulligan', uids: [] };
  if (g.current !== i || q) return null;
  const v = g.view(i), p = g.players[i];
  if (!p.manaActionUsed) { const c = ['T', 'W', 'B'].find(k => p.mana[k].lvl < 4); if (c) return { type: 'mana', city: c }; }
  const c = v.me.hand.find(x => x.playable); if (c) { const o = g.players[1 - i].board; return { type: 'play', uid: c.uid, target: o[0] ? o[0].uid : 'hero' }; }
  const u = v.me.board.find(x => x.canAttack); if (u) { const t = g.players[1 - i].board.find(x => x.taunt); return { type: 'attack', uid: u.uid, target: t ? t.uid : 'hero' }; }
  return { type: 'end' };
}
function run(seats, pols) {
  const g = new Game('ai', seats); g.start();
  let slowest = 0, steps = 0;
  while (!g.over && steps++ < 4000) {
    let acted = false;
    for (const i of [0, 1]) {
      const t0 = Date.now(); const a = pols[i](g, i); slowest = Math.max(slowest, Date.now() - t0);
      if (!a) continue;
      try { g.action(i, a); } catch (e) { if (!(e instanceof GameError)) throw e; g.action(i, { type: 'end' }); }
      acted = true; break;
    }
    if (!acted) break;
  }
  return { g, slowest };
}

let wins = 0, slow = 0;
for (let n = 0; n < 30; n++) {
  const d = deck();
  const { g, slowest } = run([{ userId: 'ai', name: 'AI', deck: d }, { userId: 'n', name: 'N', deck: d.slice() }], [AI.decide, naive]);
  assert(g.over, 'gra musi się skończyć');
  if (g.winner === 0) wins++;
  slow = Math.max(slow, slowest);
}
assert(wins >= 25, `AI wygrało tylko ${wins}/30 z prostym graczem`);
assert(slow < 1500, `decyzja AI trwała ${slow} ms`);
console.log(`✓ AI pokonuje prostego gracza ${wins}/30 (najdłuższa decyzja ${slow} ms)`);

for (const id of Object.keys(BOTS)) {
  const { g } = run([botSeat(BOTS[id]), { userId: 'p', name: 'P', deck: deck() }], [AI.decide, AI.decide]);
  assert(g.over, id + ': gra musi się skończyć');
}
console.log('✓ każdy boss rozgrywa pełną grę bez błędów');
console.log('\nTest AI zaliczony.');
