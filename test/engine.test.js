// Testy silnika: konkretne efekty + tysiące losowych gier (szukanie wyjątków i złamanych zasad).
'use strict';
const assert = require('assert');
const { Game, GameError, CARDS, BY_NAME, BOARD_LIMIT, HAND_LIMIT } = require('../server/engine');

const allNames = CARDS.map(c => c.name);
function randomDeck() {
  const d = [];
  while (d.length < 20) {
    const c = CARDS[Math.floor(Math.random() * CARDS.length)];
    const max = c.rarity === 1 ? 3 : 1;
    if (d.filter(x => x === c.name).length < max) d.push(c.name);
  }
  return d;
}
function newGame(deckA = randomDeck(), deckB = randomDeck()) {
  const g = new Game('t', [
    { userId: 'a', name: 'A', deck: deckA },
    { userId: 'b', name: 'B', deck: deckB },
  ]);
  g.start();
  return g;
}
function giveMana(g, i, n = 4) { for (const c of ['T', 'W', 'B']) g.players[i].mana[c] = { lvl: n, prog: 0, used: 0 }; }
function put(g, i, name) { const c = g.newCard(name); g.players[i].hand.push(c); return c; }

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓', name); }

test('wszystkie efekty kart są obsługiwane', () => {
  const known = ['', 'HealFriendlyHero', 'DamageEnemyHero', 'SummonGirlfriends', 'DestroyAllMinionsDiscardHand', 'SetHealthTo30', 'ResurrectRandomUnit', 'DamageAllExceptProgrammers', 'ReturnToHandRandom', 'ChargeDiscardTwo', 'BuffIfProgrammerInHand', 'AddRandomSpellToHand', 'OpponentDiscardsCard', 'DrawCardWithTag', 'DrawSpecificCard', 'Draw5Spells', 'BuffIfProgrammerInHandHealth', 'FreezeAllEnemies', 'DamageRandomEnemy3Times', 'DestroyTargetMinion', 'SummonRandomUnit', 'DamageAllEnemies', 'DamageAndDiscard', 'IncreaseBydgoszczMana', 'DiscardCardFromHand', 'ReturnFriendlyToHand', 'BuffIfProgrammerInHandBoth', 'BuffPerCardInHand', 'SetEnemyHealthToYours', 'DamageSelfAndDraw', 'DamageBothHeroes'];
  for (const c of CARDS) assert(known.includes(c.effect), 'brak efektu ' + c.effect);
});

test('start: 3 karty + dobranie w turze pierwszego gracza', () => {
  const g = newGame();
  assert.strictEqual(g.players[g.current].hand.length, 4);
  assert.strictEqual(g.players[1 - g.current].hand.length, 3);
});

test('mana: jedna rozbudowa na turę, koszty 1,1,2,2', () => {
  const g = newGame(); const i = g.current;
  g.action(i, { type: 'mana', city: 'T' });
  assert.strictEqual(g.players[i].mana.T.lvl, 1);
  assert.throws(() => g.action(i, { type: 'mana', city: 'W' }), GameError);
  const p = g.players[i];
  p.mana.T = { lvl: 2, prog: 0, used: 0 };
  g.addManaProgress(p, 'T'); assert.strictEqual(p.mana.T.lvl, 2);
  g.addManaProgress(p, 'T'); assert.strictEqual(p.mana.T.lvl, 3);
});

test('nie można działać w turze przeciwnika', () => {
  const g = newGame();
  assert.throws(() => g.action(1 - g.current, { type: 'end' }), GameError);
});

test('koszt "Dowolna" i miast', () => {
  const g = newGame(); const i = g.current; const p = g.players[i];
  p.mana.T = { lvl: 2, prog: 0, used: 0 }; p.mana.W = { lvl: 0, prog: 0, used: 0 }; p.mana.B = { lvl: 0, prog: 0, used: 0 };
  const aga = put(g, i, 'Agnieszka'); // T2 + D1
  assert.throws(() => g.action(i, { type: 'play', uid: aga.uid }), /stać/);
  p.mana.B.lvl = 1;
  g.action(i, { type: 'play', uid: aga.uid });
  assert(p.board.find(u => u.name === 'Agnieszka'));
  assert.strictEqual(g.available(p, 'T') + g.available(p, 'B'), 0);
});

test('atak jednostki i obrażenia zwrotne, brak ataku w turze zagrania', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  giveMana(g, i);
  const c = put(g, i, '67'); g.action(i, { type: 'play', uid: c.uid });
  const u = g.players[i].board.find(x => x.uid === c.uid);
  assert.throws(() => g.action(i, { type: 'attack', uid: u.uid, target: 'hero' }), GameError);
  g.action(i, { type: 'end' }); g.action(o, { type: 'end' });
  const hp = g.players[o].hp;
  g.action(i, { type: 'attack', uid: u.uid, target: 'hero' });
  assert.strictEqual(g.players[o].hp, hp - 6);
});

test('szarża Błażeja i odrzucenie 2 kart', () => {
  const g = newGame(); const i = g.current;
  giveMana(g, i);
  const b = put(g, i, 'Błażej');
  const before = g.players[i].hand.length;
  g.action(i, { type: 'play', uid: b.uid });
  assert.strictEqual(g.players[i].hand.length, before - 3);
  g.action(i, { type: 'attack', uid: b.uid, target: 'hero' });
});

test('moc pieśni dodaje się do obrażeń piosenek', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  giveMana(g, i);
  g.summon(i, g.newCard('SzyRRogi'), { battlecry: false });
  const s = put(g, i, 'Diss na taksówkarzy');
  const hp = g.players[o].hp;
  g.action(i, { type: 'play', uid: s.uid });
  assert.strictEqual(g.players[o].hp, hp - 9);
});

test('Tael obniża koszt piosenek, Runia rośnie od piosenek', () => {
  const g = newGame(); const i = g.current;
  g.summon(i, g.newCard('Tael'), { battlecry: false });
  const r = g.summon(i, g.newCard('Runia'), { battlecry: false });
  const s = put(g, i, 'Oczekiwania');
  assert.strictEqual(g.effectiveCost(i, s).D, 4);
  giveMana(g, i);
  g.action(i, { type: 'play', uid: s.uid });
  assert.strictEqual(r.atk, 1);
});

test('Lian atakuje dwa razy', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const l = g.summon(i, g.newCard('Lian'), { battlecry: false });
  g.action(i, { type: 'end' }); g.action(o, { type: 'end' });
  g.action(i, { type: 'attack', uid: l.uid, target: 'hero' });
  g.action(i, { type: 'attack', uid: l.uid, target: 'hero' });
  assert.throws(() => g.action(i, { type: 'attack', uid: l.uid, target: 'hero' }), GameError);
});

test('Olaf ma podwójny atak z Agnieszką', () => {
  const g = newGame(); const i = g.current;
  const olaf = g.summon(i, g.newCard('Olaf'), { battlecry: false });
  assert.strictEqual(g.attackOf(i, olaf), 4);
  g.summon(i, g.newCard('Agnieszka'), { battlecry: false });
  assert.strictEqual(g.attackOf(i, olaf), 8);
});

test('zamrożenie blokuje atak w następnej turze', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const enemy = g.summon(o, g.newCard('67'), { battlecry: false });
  giveMana(g, i);
  const f = put(g, i, 'Wieczni Chłodne Dłonie');
  g.action(i, { type: 'play', uid: f.uid });
  g.action(i, { type: 'end' });
  assert.throws(() => g.action(o, { type: 'attack', uid: enemy.uid, target: 'hero' }), /zamro/);
  g.action(o, { type: 'end' }); g.action(i, { type: 'end' });
  g.action(o, { type: 'attack', uid: enemy.uid, target: 'hero' });
});

test('Ola z kajaków znika po 2 turach', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  g.summon(i, g.newCard('Ola z kajaków'), { battlecry: false });
  g.action(i, { type: 'end' }); g.action(o, { type: 'end' });
  assert(g.players[i].board.some(u => u.name === 'Ola z kajaków'));
  g.action(i, { type: 'end' }); g.action(o, { type: 'end' });
  assert(!g.players[i].board.some(u => u.name === 'Ola z kajaków'));
});

test('Gustav po cichu znika po 2 turach, Jeżyk nie dobiera Julki', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const gu = g.summon(i, g.newCard('Gustav'), { battlecry: false });
  assert.strictEqual(g.view(i).me.board.find(u => u.uid === gu.uid).turnsLeft, null);
  g.action(i, { type: 'end' }); g.action(o, { type: 'end' });
  assert(g.players[i].board.includes(gu));
  g.action(i, { type: 'end' }); g.action(o, { type: 'end' });
  assert(!g.players[i].board.includes(gu));
  g.players[i].deck = [g.newCard('Julka')];
  g.runEffect('DrawSpecificCard', 0, i, false, null);
  assert.strictEqual(g.players[i].deck.length, 1);
});

test('Jędrek: odrzucone jednostki wchodzą na planszę', () => {
  const g = newGame(); const i = g.current;
  g.summon(i, g.newCard('Jędrek'), { battlecry: false });
  g.players[i].hand = [g.newCard('67')];
  g.discardRandom(i);
  assert(g.players[i].board.some(u => u.name === '67'));
});

test('Zniszcz wybraną jednostkę', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const a = g.summon(o, g.newCard('67'), { battlecry: false });
  const b = g.summon(o, g.newCard('Kubba'), { battlecry: false });
  giveMana(g, i);
  const s = put(g, i, 'Jestem zmęczony za bardzo');
  g.action(i, { type: 'play', uid: s.uid, target: b.uid });
  assert(g.players[o].board.includes(a) && !g.players[o].board.includes(b));
});

test('wygrana po zbiciu HP do zera, potem żadnych akcji', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  g.players[o].hp = 3; giveMana(g, i);
  const s = put(g, i, 'Diss na taksówkarzy');
  g.action(i, { type: 'play', uid: s.uid });
  assert(g.over); assert.strictEqual(g.winner, i);
  assert.throws(() => g.action(i, { type: 'end' }), GameError);
});

test('Moja Przygoda: przy jednoczesnej śmierci przegrywa rzucający', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  g.players[i].hp = 5; g.players[o].hp = 5; giveMana(g, i);
  const s = put(g, i, 'Moja Przygoda (Remix)');
  g.action(i, { type: 'play', uid: s.uid });
  assert.strictEqual(g.winner, o);
});

test('poddanie się działa także poza swoją turą', () => {
  const g = newGame(); const o = 1 - g.current;
  g.action(o, { type: 'concede' });
  assert.strictEqual(g.winner, g.current);
});

test('widok ukrywa rękę przeciwnika', () => {
  const g = newGame(); const v = g.view(0);
  assert(Array.isArray(v.me.hand)); assert(!('hand' in v.opp)); assert.strictEqual(typeof v.opp.handCount, 'number');
});

test('5000 losowych gier bez błędów i z zachowaniem limitów', () => {
  let finished = 0;
  for (let n = 0; n < 5000; n++) {
    const g = newGame();
    let steps = 0;
    while (!g.over && steps < 3000) {
      steps++;
      const i = g.current, p = g.players[i], o = g.players[1 - i];
      const moves = [];
      if (!p.manaActionUsed) for (const c of ['T', 'W', 'B']) if (p.mana[c].lvl < 4) moves.push({ type: 'mana', city: c });
      for (const c of p.hand) if (g.canPay(p, g.effectiveCost(i, c)) && !(BY_NAME[c.name].type === 'unit' && p.board.length >= BOARD_LIMIT)) {
        const tgt = o.board.length ? o.board[Math.floor(Math.random() * o.board.length)].uid : undefined;
        moves.push({ type: 'play', uid: c.uid, target: tgt });
      }
      for (const u of p.board) if (u.attacksLeft > 0) {
        moves.push({ type: 'attack', uid: u.uid, target: 'hero' });
        for (const t of o.board) moves.push({ type: 'attack', uid: u.uid, target: t.uid });
      }
      const m = moves.length && Math.random() < 0.85 ? moves[Math.floor(Math.random() * moves.length)] : { type: 'end' };
      g.action(i, m);
      for (const pl of g.players) {
        assert(pl.board.length <= BOARD_LIMIT, 'limit planszy');
        assert(pl.hand.length <= HAND_LIMIT, 'limit ręki');
        for (const c of ['T', 'W', 'B']) assert(pl.mana[c].used <= pl.mana[c].lvl && pl.mana[c].lvl <= 4, 'mana');
        if (!g.over) for (const u of pl.board) assert(u.hp > 0, 'martwa jednostka na planszy');
      }
      g.view(0); g.view(1);
    }
    if (g.over) finished++;
  }
  assert(finished > 4900, 'za mało gier się skończyło: ' + finished);
});

console.log(`\nWszystkie testy zaliczone (${passed}).`);
