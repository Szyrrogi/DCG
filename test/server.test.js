// Test integracyjny serwera: 6 kont, paczki, talie, wyzwania, pełne mecze przez WebSocket,
// nagrody +10 i bonus +100 po pokonaniu 5 różnych graczy (z resetem listy).
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3999;
const DATA_FILE = path.join(os.tmpdir(), 'dcg-test-' + Date.now() + '.json');

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { ws, name, inbox: [], waiters: [], me: null, view: null, cards: null };
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'me' || m.t === 'auth') c.me = m.me;
      if (m.t === 'auth') c.cards = m.cards;
      if (m.t === 'game') c.view = m.view;
      c.inbox.push(m);
      c.waiters = c.waiters.filter(w => { if (w.pred(m)) { w.res(m); return false; } return true; });
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
    c.send = m => ws.send(JSON.stringify(m));
    c.wait = (pred, ms = 4000) => new Promise((res, rej) => {
      const hit = c.inbox.find(pred);
      if (hit) { c.inbox.splice(c.inbox.indexOf(hit), 1); return res(hit); }
      const w = { pred, res: m => { c.inbox.splice(c.inbox.indexOf(m), 1); clearTimeout(w.t); res(m); } };
      w.t = setTimeout(() => rej(new Error(`${name}: timeout czekania`)), ms);
      c.waiters.push(w);
    });
  });
}

async function buildDeck(c) {
  const by = Object.fromEntries(c.cards.map(x => [x.name, x]));
  for (;;) {
    while (c.me.packs.std > 0) { c.send({ t: 'openPack', kind: 'std' }); await c.wait(m => m.t === 'packOpened'); await c.wait(m => m.t === 'me'); }
    while (c.me.packs.leg > 0) { c.send({ t: 'openPack', kind: 'leg' }); await c.wait(m => m.t === 'packOpened'); await c.wait(m => m.t === 'me'); }
    const deck = [];
    for (const [n, k] of Object.entries(c.me.collection)) for (let i = 0; i < Math.min(k, by[n].rarity === 1 ? 3 : 1) && deck.length < 20; i++) deck.push(n);
    if (deck.length === 20) {
      c.send({ t: 'saveDeck', name: 'Test', cards: deck });
      const r = await c.wait(m => m.t === 'deckSaved' || m.t === 'error');
      assert.strictEqual(r.t, 'deckSaved', r.msg);
      await c.wait(m => m.t === 'me');
      return r.id;
    }
    c.send({ t: 'buyPack', kind: 'std' }); await c.wait(m => m.t === 'me');
  }
}

// prosta "sztuczna inteligencja": gra karty, rozbudowuje miasta, bije w twarz
function chooseMove(v) {
  const me = v.me;
  if (v.pending && v.pending.mine) return v.pending.type === 'discard' ? { type: 'choose', uid: me.hand[0].uid } : { type: 'choose', name: v.pending.options[0] };
  if (!me.manaActionUsed) { const c = ['T', 'W', 'B'].sort((a, b) => me.mana[a].lvl - me.mana[b].lvl)[0]; if (me.mana[c].lvl < 4) return { type: 'mana', city: c }; }
  const p = me.hand.find(c => c.playable);
  if (p) return { type: 'play', uid: p.uid, target: v.opp.board[0] && v.opp.board[0].uid };
  const u = me.board.find(x => x.canAttack);
  if (u) return { type: 'attack', uid: u.uid, target: 'hero' };
  return { type: 'end' };
}

async function playMatch(a, b, aDeck, bDeck) {
  a.view = b.view = null; a.inbox.length = 0; b.inbox.length = 0;
  a.send({ t: 'challenge', to: b.me.id, deckId: aDeck });
  const ch = await b.wait(m => m.t === 'challenged');
  b.send({ t: 'acceptChallenge', from: ch.from, deckId: bDeck });
  await a.wait(m => m.t === 'game'); await b.wait(m => m.t === 'game');
  // wymiana kart startowych: a wymienia pierwszą kartę, b zostawia rękę
  a.send({ t: 'act', action: { type: 'mulligan', uids: [a.view.me.hand[0].uid] } });
  b.send({ t: 'act', action: { type: 'mulligan', uids: [] } });
  await a.wait(m => m.t === 'game' && m.view.phase === 'play'); await b.wait(m => m.t === 'game' && m.view.phase === 'play');
  let guard = 0;
  for (;;) {
    if (++guard > 3000) throw new Error('mecz się nie kończy');
    const actor = a.view.myTurn ? a : b;
    if (a.view.over) break;
    const seq = actor.view.seq;
    actor.send({ t: 'act', action: chooseMove(actor.view) });
    const r = await actor.wait(m => (m.t === 'game' && m.view.seq > seq) || m.t === 'error');
    if (r.t === 'error') { actor.send({ t: 'act', action: { type: 'end' } }); await actor.wait(m => m.t === 'game'); }
    await new Promise(r => setImmediate(r));
  }
  const ra = await a.wait(m => m.t === 'gameOver'); const rb = await b.wait(m => m.t === 'gameOver');
  await a.wait(m => m.t === 'me'); await b.wait(m => m.t === 'me');
  return ra.result === 'win' ? [a, b, ra] : [b, a, rb];
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_FILE, DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('działa')) r(); }));
  try {
    const names = ['juli', 'jedrek', 'szyrrogi', 'olaf', 'tofame', 'massyn']; // 'jedrek' loguje na 'jędrek'
    const cs = [];
    for (const n of names) {
      const c = await client(n);
      c.send({ t: 'login', username: n.toLowerCase(), password: 'haslo' });
      await c.wait(m => m.t === 'auth');
      assert.strictEqual(c.me.gold, 1000);
      cs.push(c);
    }
    console.log('✓ 6 kont loguje się hasłem "haslo"');

    const bad = await client('x'); bad.send({ t: 'login', username: 'szyrrogi', password: 'zle' });
    assert.strictEqual((await bad.wait(m => m.t === 'loginError')).t, 'loginError'); bad.ws.close();
    console.log('✓ złe hasło odrzucone');

    const decks = [];
    for (const c of cs) decks.push(await buildDeck(c));
    console.log('✓ paczki otwierane, talie zbudowane');

    // nieprawidłowa talia
    cs[0].send({ t: 'saveDeck', name: 'Zła', cards: ['Massyn', 'Massyn'] });
    assert.strictEqual((await cs[0].wait(m => m.t === 'error')).t, 'error');
    console.log('✓ walidacja talii');

    // Igor (2) gra z każdym innym, dopóki nie pokona 5 różnych → bonus
    const igor = cs[2];
    const startGold = igor.me.gold;
    let wins = 0, gotBonus = false;
    const beaten = new Set();
    for (let round = 0; round < 60 && !gotBonus; round++) {
      const others = cs.filter(c => c !== igor && !beaten.has(c.me.id));
      const opp = others[round % others.length];
      const [w, l, res] = await playMatch(igor, opp, decks[2], decks[cs.indexOf(opp)]);
      if (w === igor) {
        wins++; beaten.add(l.me.id);
        if (beaten.size < 5) { assert.strictEqual(res.reward.gold, 10); assert.strictEqual(res.reward.bonus, 0); assert.strictEqual(igor.me.defeated.length, beaten.size); }
        else { assert.strictEqual(res.reward.bonus, 100); assert.deepStrictEqual(igor.me.defeated, []); gotBonus = true; }
      } else {
        assert.strictEqual(res.reward.gold, 10);
      }
    }
    assert(gotBonus, 'szyrrogi nie zdobył bonusu');
    assert.strictEqual(igor.me.gold, startGold + wins * 10 + 100);
    console.log(`✓ nagrody: ${wins} wygranych szyrrogi → +${wins * 10} + bonus 100, lista pokonanych zresetowana`);

    // poddanie się
    const [w2, l2] = await (async () => {
      const a = cs[0], b = cs[1];
      a.send({ t: 'challenge', to: b.me.id, deckId: decks[0] });
      const ch = await b.wait(m => m.t === 'challenged');
      b.send({ t: 'acceptChallenge', from: ch.from, deckId: decks[1] });
      await b.wait(m => m.t === 'game'); await a.wait(m => m.t === 'game');
      b.send({ t: 'act', action: { type: 'concede' } });
      const r = await a.wait(m => m.t === 'gameOver');
      assert.strictEqual(r.result, 'win'); assert.strictEqual(r.reason, 'concede');
      return [a, b];
    })();
    console.log('✓ poddanie się daje wygraną przeciwnikowi');

    // zmiana hasła i ponowne logowanie
    const j = cs[0];
    j.send({ t: 'changePassword', oldPassword: 'haslo', newPassword: 'nowe123', token: null });
    await j.wait(m => m.t === 'toast');
    const j2 = await client('Juli2');
    j2.send({ t: 'login', username: 'JULI', password: 'haslo' });
    assert.strictEqual((await j2.wait(m => m.t === 'loginError')).t, 'loginError');
    j2.send({ t: 'login', username: 'JULI', password: 'nowe123' });
    await j2.wait(m => m.t === 'auth');
    console.log('✓ zmiana hasła działa');

    // reconnect w trakcie gry (token)
    const a = cs[3], b = cs[4];
    a.inbox.length = 0; b.inbox.length = 0;
    a.send({ t: 'challenge', to: b.me.id, deckId: decks[3] });
    const ch = await b.wait(m => m.t === 'challenged');
    b.send({ t: 'acceptChallenge', from: ch.from, deckId: decks[4] });
    const gv = await a.wait(m => m.t === 'game');
    a.ws.close();
    await b.wait(m => m.t === 'opponentLeft');
    const a2 = await client('Olaf2');
    const authMsg = await new Promise(async res => {
      const c = await client('tmp'); c.send({ t: 'login', username: 'Olaf', password: 'haslo' }); res(await c.wait(m => m.t === 'auth')); c.ws.close();
    });
    a2.send({ t: 'resume', token: authMsg.token });
    await a2.wait(m => m.t === 'auth');
    const back = await a2.wait(m => m.t === 'game');
    assert.strictEqual(back.view.id, gv.view.id);
    await b.wait(m => m.t === 'opponentBack');
    console.log('✓ powrót do trwającej gry po rozłączeniu');

    // rejestracja nowego konta z awatarem z karty
    const nw = await client('nowy');
    nw.send({ t: 'register', username: 'Jędrek', password: 'abcd', avatar: 'c:Massyn' });
    assert.strictEqual((await nw.wait(m => m.t === 'registerError')).t, 'registerError'); // zajęta (jędrek)
    nw.send({ t: 'register', username: 'Kuba_7', password: 'abcd', avatar: 'c:NieMaTakiejKarty' });
    await nw.wait(m => m.t === 'registerError');
    nw.send({ t: 'register', username: 'Kuba_7', password: 'abcd', avatar: 'c:Massyn' });
    const reg = await nw.wait(m => m.t === 'auth');
    assert.strictEqual(reg.me.avatar, 'c:Massyn'); assert.strictEqual(reg.me.gold, 1000); assert.strictEqual(reg.me.isAdmin, false);
    assert(!reg.cards.find(c => c.name === 'Gustav').hiddenDeath, 'ukryta zdolność wycieka do klienta');
    const list = await (await fetch(`http://localhost:${PORT}/api/users`)).json();
    assert.strictEqual(list.length, 7);
    console.log('✓ zakładanie konta z awatarem z karty');

    // admin: tylko szyrrogi może zmieniać złoto
    nw.send({ t: 'adminSetGold', id: igor.me.id, gold: 5 });
    assert.match((await nw.wait(m => m.t === 'error')).msg, /uprawnień/);
    const adm = cs[2];
    assert.strictEqual(adm.me.isAdmin, true);
    adm.send({ t: 'adminSetGold', id: reg.me.id, gold: 4321 });
    await nw.wait(m => m.t === 'me' && m.me.gold === 4321);
    adm.send({ t: 'adminAddGold', id: reg.me.id, amount: -321 });
    await nw.wait(m => m.t === 'me' && m.me.gold === 4000);
    adm.send({ t: 'adminSetPacks', id: reg.me.id, std: 3, leg: 2 });
    await nw.wait(m => m.t === 'me' && m.me.packs.std === 3 && m.me.packs.leg === 2);
    console.log('✓ panel admina zmienia złoto i paczki');

    // dane zapisane na dysku
    await new Promise(r => setTimeout(r, 600));
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    assert.strictEqual(saved.users.length, 7);
    assert(saved.users.find(u => u.username === 'szyrrogi').stats.bonuses === 1);
    console.log('✓ dane zapisane trwale');
    console.log('\nTest serwera zaliczony.');
  } catch (e) {
    console.error('BŁĄD:', e); process.exitCode = 1;
  } finally {
    srv.kill();
    try { fs.unlinkSync(DATA_FILE); } catch { }
    process.exit(process.exitCode || 0);
  }
})().catch(e => { console.error('BŁĄD:', e); process.exitCode = 1; });
