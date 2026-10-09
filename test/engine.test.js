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
  g.action(0, { type: 'mulligan', uids: [] });
  g.action(1, { type: 'mulligan', uids: [] });
  return g;
}
function pickPending(g) {
  // rozwiązuje oczekujący wybór pierwszą/losową opcją
  const q = g.pending; if (!q) return;
  const p = g.players[q.player];
  if (q.type === 'discard') g.action(q.player, { type: 'choose', uid: p.hand[Math.floor(Math.random() * p.hand.length)].uid });
  else g.action(q.player, { type: 'choose', name: q.options[Math.floor(Math.random() * q.options.length)] });
}
function giveMana(g, i, n = 4) { for (const c of ['T', 'W', 'B']) g.players[i].mana[c] = { lvl: n, prog: 0, used: 0 }; }
function put(g, i, name) { const c = g.newCard(name); g.players[i].hand.push(c); return c; }

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓', name); }

test('wszystkie efekty kart są obsługiwane', () => {
  const known = ['', 'HealFriendlyHero', 'DamageEnemyHero', 'SummonGirlfriends', 'DestroyAllMinionsDiscardHand', 'SetHealthTo30', 'ResurrectFriendlyUnit', 'ChanceBuff', 'DrawCards', 'DrawNamedCard', 'DrawTwoWithTag', 'DamageAllExceptProgrammers', 'ReturnToHandRandom', 'ChargeDiscardTwo', 'BuffIfProgrammerInHand', 'AddRandomSpellToHand', 'OpponentDiscardsCard', 'DrawCardWithTag', 'DrawSpecificCard', 'Draw5Spells', 'BuffIfProgrammerInHandHealth', 'FreezeAllEnemies', 'DamageRandomEnemy3Times', 'DestroyTargetMinion', 'SummonRandomUnit', 'DamageAllEnemies', 'DamageAndDiscard', 'IncreaseBydgoszczMana', 'DiscardCardFromHand', 'ReturnFriendlyToHand', 'BuffIfProgrammerInHandBoth', 'BuffPerCardInHand', 'SetEnemyHealthToYours', 'DamageSelfAndDraw', 'DamageBothHeroes'];
  for (const c of CARDS) assert(known.includes(c.effect), 'brak efektu ' + c.effect);
});

test('start: zaczynający 3 karty + dobranie, drugi gracz 4 karty', () => {
  const g = newGame();
  assert.strictEqual(g.players[g.current].hand.length, 4);
  assert.strictEqual(g.players[1 - g.current].hand.length, 4);
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
  assert.strictEqual(g.pending.type, 'discard'); assert.strictEqual(g.pending.count, 2);
  assert.throws(() => g.action(i, { type: 'attack', uid: b.uid, target: 'hero' }), /odrzucenia/);
  const [c1, c2] = g.players[i].hand;
  g.action(i, { type: 'choose', uid: c1.uid });
  g.action(i, { type: 'choose', uid: c2.uid });
  assert.strictEqual(g.players[i].hand.length, before - 3);
  assert(!g.players[i].hand.includes(c1) && !g.players[i].hand.includes(c2));
  assert(g.players[i].grave.includes(c1.name));
  g.action(i, { type: 'attack', uid: b.uid, target: 'hero' });
});

test('mulligan: wymienione karty wracają do talii, gra startuje po obu graczach', () => {
  const g = new Game('m', [{ userId: 'a', name: 'A', deck: randomDeck() }, { userId: 'b', name: 'B', deck: randomDeck() }]);
  g.start();
  assert.strictEqual(g.phase, 'mulligan');
  assert.throws(() => g.action(g.current, { type: 'end' }), /wymiana/i);
  const n0 = g.players[0].hand.length;
  assert.strictEqual(n0, g.current === 0 ? 3 : 4);
  const h = g.players[0].hand.slice(0, 2).map(c => c.uid);
  g.action(0, { type: 'mulligan', uids: h });
  assert.strictEqual(g.players[0].hand.length, n0);
  assert(!g.players[0].hand.some(c => h.includes(c.uid)));
  assert.strictEqual(g.players[0].deck.length, 20 - n0);
  assert.strictEqual(g.phase, 'mulligan');
  g.action(1, { type: 'mulligan', uids: [] });
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.players[g.current].hand.length, 4);
});

test('Agnieszka wskrzesza losową poległą jednostkę, Olaf ma pierwszeństwo, odrzucone się nie liczą', () => {
  const g = newGame(); const i = g.current;
  giveMana(g, i);
  const me = g.players[i];
  me.grave.push('Massyn');            // odrzucona, nie zginęła
  const a = g.summon(i, g.newCard('Kubba'), { battlecry: false }); g.destroyUnit(i, a);
  const b = g.summon(i, g.newCard('67'), { battlecry: false }); g.destroyUnit(i, b);
  const ag = put(g, i, 'Agnieszka');
  g.action(i, { type: 'play', uid: ag.uid });
  assert.strictEqual(g.pending, null);
  assert(me.board.some(u => ['Kubba', '67'].includes(u.name)));
  assert(!me.board.some(u => u.name === 'Massyn'));
  const o = g.summon(i, g.newCard('Olaf'), { battlecry: false }); g.destroyUnit(i, o);
  giveMana(g, i);
  const ag2 = put(g, i, 'Agnieszka');
  g.action(i, { type: 'play', uid: ag2.uid });
  assert(me.board.some(u => u.name === 'Olaf'));
});

test('Zuzia kończy turę po zagraniu', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  giveMana(g, i);
  g.players[i].hp = 10;
  const z = put(g, i, 'Zuzia');
  g.action(i, { type: 'play', uid: z.uid });
  assert.strictEqual(g.players[o].hp, 10);
  assert.strictEqual(g.current, o);
});

test('Natis +2/+1, Song Jinwoo rośnie na początku tury, Siostra kosztuje 1', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  giveMana(g, i);
  g.players[i].hand.push(g.newCard('Ksawery'));
  const n = put(g, i, 'Natis');
  g.action(i, { type: 'play', uid: n.uid });
  const nu = g.players[i].board.find(u => u.uid === n.uid);
  assert.strictEqual(nu.atk, 4); assert.strictEqual(nu.hp, 4);
  const s = g.summon(i, g.newCard('Song Jinwoo'), { battlecry: false });
  assert.strictEqual(s.atk, 1); assert.strictEqual(s.hp, 1);
  g.action(i, { type: 'end' });
  assert.strictEqual(s.atk, 1);
  g.action(o, { type: 'end' });
  assert.strictEqual(s.atk, 2); assert.strictEqual(s.hp, 2);
  assert.strictEqual(BY_NAME['Siostra Kirszenstein'].cost.D, 1);
});

test('Jade Jade Jade może trafić też wrogiego bohatera', () => {
  let heroHit = false;
  for (let k = 0; k < 50 && !heroHit; k++) {
    const g = newGame(); const i = g.current, o = 1 - i;
    g.summon(o, g.newCard('67'), { battlecry: false });
    const hp = g.players[o].hp;
    g.runEffect('DamageRandomEnemy3Times', 1, i, true, null);
    if (g.players[o].hp < hp) heroHit = true;
  }
  assert(heroHit);
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
  assert.strictEqual(r.atk, 1); assert.strictEqual(r.hp, 4);
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
  assert(!g.players[i].dead.includes('Ola z kajaków'), 'zniknięcie to nie śmierć');
});

test('Gustav po cichu znika po 3 turach, Jeżyk nie dobiera Julki', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const gu = g.summon(i, g.newCard('Gustav'), { battlecry: false });
  assert.strictEqual(g.view(i).me.board.find(u => u.uid === gu.uid).turnsLeft, null);
  for (let k = 0; k < 2; k++) { g.action(i, { type: 'end' }); g.action(o, { type: 'end' }); }
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
  g.players[i].hp = 4; g.players[o].hp = 4; giveMana(g, i);
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
    const g = new Game('f', [{ userId: 'a', name: 'A', deck: randomDeck() }, { userId: 'b', name: 'B', deck: randomDeck() }]);
    g.start();
    for (const s of [0, 1]) g.action(s, { type: 'mulligan', uids: g.players[s].hand.filter(() => Math.random() < 0.4).map(c => c.uid) });
    let steps = 0;
    while (!g.over && steps < 3000) {
      steps++;
      if (g.pending) { pickPending(g); continue; }
      const i = g.current, p = g.players[i], o = g.players[1 - i];
      const moves = [];
      if (!p.manaActionUsed) for (const c of ['T', 'W', 'B']) if (p.mana[c].lvl < 4) moves.push({ type: 'mana', city: c });
      for (const c of p.hand) if (g.canPay(p, g.effectiveCost(i, c)) && !(BY_NAME[c.name].type === 'unit' && p.board.length >= BOARD_LIMIT)) {
        const tgt = o.board.length ? o.board[Math.floor(Math.random() * o.board.length)].uid : undefined;
        moves.push({ type: 'play', uid: c.uid, target: tgt });
      }
      const taunts = o.board.filter(t => BY_NAME[t.name].taunt);
      for (const u of p.board) if (u.attacksLeft > 0) {
        if (!taunts.length) moves.push({ type: 'attack', uid: u.uid, target: 'hero' });
        for (const t of (taunts.length ? taunts : o.board)) moves.push({ type: 'attack', uid: u.uid, target: t.uid });
      }
      if (Math.random() < 0.3) for (const c of p.hand) {   // losowy (czasem zły) wybór many
        moves.push({ type: 'play', uid: c.uid, pay: { T: Math.floor(Math.random() * 3), W: Math.floor(Math.random() * 3), B: Math.floor(Math.random() * 3) }, target: Math.random() < 0.5 ? 'hero' : undefined });
      }
      const m = moves.length && Math.random() < 0.85 ? moves[Math.floor(Math.random() * moves.length)] : { type: 'end' };
      try { g.action(i, m); } catch (e) { if (!(e instanceof GameError) || m.type !== 'play' || !m.pay) throw e; }
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

test('wybór many: gracz decyduje, z którego miasta płaci koszt dowolny', () => {
  const g = newGame(); const i = g.current; const p = g.players[i];
  for (const c of ['T', 'W', 'B']) p.mana[c] = { lvl: 2, prog: 0, used: 0 };
  const c = put(g, i, 'Ramus');   // 2 dowolnej
  g.action(i, { type: 'play', uid: c.uid, pay: { T: 0, W: 0, B: 2 } });
  assert.strictEqual(p.mana.B.used, 2); assert.strictEqual(p.mana.T.used, 0);
  const c2 = put(g, i, 'Ramus');
  g.action(i, { type: 'play', uid: c2.uid, pay: { T: 5 } });   // zły wybór → automatycznie
  assert.strictEqual(p.mana.T.used + p.mana.W.used, 2);
});

test('Tael obniża też piosenki bez kosztu dowolnego', () => {
  const g = newGame(); const i = g.current;
  g.summon(i, g.newCard('Tael'), { battlecry: false });
  const s = put(g, i, 'Moja Przygoda (Remix)');   // 1 Warszawa
  const c = g.effectiveCost(i, s);
  assert.strictEqual(c.W + c.D + c.T + c.B, 0);
});

test('Prowokacja: najpierw trzeba bić jednostkę z Prowokacją', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const t = g.summon(o, g.newCard('Ramus'), { battlecry: false });
  const k = g.summon(o, g.newCard('Kubba'), { battlecry: false });
  const a = g.summon(i, g.newCard('67'), { battlecry: false }); a.attacksLeft = 2;
  assert.throws(() => g.action(i, { type: 'attack', uid: a.uid, target: 'hero' }), /Prowokacj/);
  assert.throws(() => g.action(i, { type: 'attack', uid: a.uid, target: k.uid }), /Prowokacj/);
  g.action(i, { type: 'attack', uid: a.uid, target: t.uid });
  assert(!g.players[o].board.includes(t));
  g.action(i, { type: 'attack', uid: a.uid, target: 'hero' });
});

test('Kayle chroni bohatera przed obrażeniami', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  g.summon(o, g.newCard('Kayle'), { battlecry: false });
  giveMana(g, i);
  const s = put(g, i, 'Diss na taksówkarzy');
  g.action(i, { type: 'play', uid: s.uid });
  assert.strictEqual(g.players[o].hp, 20);
});

test('Diss na Szymona bije wybraną jednostkę', () => {
  const g = newGame(); const i = g.current, o = 1 - i;
  const u = g.summon(o, g.newCard('67'), { battlecry: false });
  giveMana(g, i);
  const s = put(g, i, 'Diss na Szymona');
  g.action(i, { type: 'play', uid: s.uid, target: u.uid });
  assert.strictEqual(u.hp, 3); assert.strictEqual(g.players[o].hp, 20);
});

test('Mordekaiser daje zużytą kulę Bydgoszczy', () => {
  const g = newGame(); const i = g.current; const p = g.players[i];
  p.mana.T = { lvl: 2, prog: 0, used: 0 }; p.mana.W = { lvl: 2, prog: 0, used: 0 }; p.mana.B = { lvl: 0, prog: 0, used: 0 };
  const m = put(g, i, 'Mordekaiser');
  g.action(i, { type: 'play', uid: m.uid });
  assert.strictEqual(p.mana.B.lvl, 1); assert.strictEqual(g.available(p, 'B'), 0);
});

test('Olaf dobiera Agnieszkę, Jeżyk obu, Siostra dwóch Lewców, :pp dwie karty', () => {
  const g = newGame(); const i = g.current; const p = g.players[i];
  giveMana(g, i);
  p.deck = ['Agnieszka', 'Julii', 'Jędrek', 'Szymon', 'Błażej', 'Eva', 'Eva'].map(n => g.newCard(n));
  const h0 = p.hand.length;
  g.action(i, { type: 'play', uid: put(g, i, 'Olaf').uid });
  g.action(i, { type: 'play', uid: put(g, i, 'Jeżyk').uid });
  g.action(i, { type: 'play', uid: put(g, i, 'Siostra Kirszenstein').uid });
  assert.deepStrictEqual(p.hand.slice(h0).map(c => c.name), ['Agnieszka', 'Julii', 'Jędrek', 'Szymon', 'Błażej']);
  giveMana(g, i);
  g.action(i, { type: 'play', uid: put(g, i, ':pp').uid });
  assert.strictEqual(p.deck.length, 0);
});

test('odrzucona jednostka może zostać wskrzeszona przez Agnieszkę', () => {
  const g = newGame(); const i = g.current; const p = g.players[i];
  giveMana(g, i);
  p.hand = [g.newCard('Massyn')];
  g.action(i, { type: 'play', uid: put(g, i, 'Grzesiek').uid });
  assert(p.dead.includes('Massyn'));
  giveMana(g, i);
  g.action(i, { type: 'play', uid: put(g, i, 'Agnieszka').uid });
  assert(p.board.some(u => u.name === 'Massyn'));
});

test('Szymon: 2/2 i 50% na +2/+1, statystyki SzyRRogi 2/9, Kubba moc +2', () => {
  let buffed = 0, plain = 0;
  for (let k = 0; k < 40; k++) {
    const g = newGame(); const i = g.current; giveMana(g, i);
    const sz = put(g, i, 'Szymon'); g.action(i, { type: 'play', uid: sz.uid });
    const u = g.players[i].board.find(x => x.uid === sz.uid);
    if (u.atk === 4 && u.hp === 3) buffed++; else if (u.atk === 2 && u.hp === 2) plain++; else assert.fail('złe statystyki');
  }
  assert(buffed > 0 && plain > 0);
  assert.strictEqual(BY_NAME.SzyRRogi.atk, 2); assert.strictEqual(BY_NAME.SzyRRogi.hp, 9); assert.strictEqual(BY_NAME.Kubba.spellPower, 2);
});

test('wskrzeszona jednostka używa Okrzyku Bojowego', () => {
  const g = newGame(); const i = g.current; const p = g.players[i];
  giveMana(g, i);
  const y = g.summon(i, g.newCard('Yeager'), { battlecry: false }); g.destroyUnit(i, y);
  p.hp = 10;
  g.action(i, { type: 'play', uid: put(g, i, 'Agnieszka').uid });
  assert(p.board.some(u => u.name === 'Yeager'));
  assert.strictEqual(p.hp, 13);
});

test('widok obserwatora pokazuje ręce obu graczy', () => {
  const g = newGame();
  const v = g.spectatorView();
  assert(v.spectator);
  assert.strictEqual(v.me.hand.length, g.players[0].hand.length);
  assert.strictEqual(v.opp.hand.length, g.players[1].hand.length);
  assert(!v.me.hand.some(c => c.playable));
});

console.log(`\nWszystkie testy zaliczone (${passed}).`);
