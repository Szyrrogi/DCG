// Test limitu tury w grze online: po upływie czasu tura kończy się sama.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3995;
const DATA_FILE = path.join(os.tmpdir(), 'dcg-timer-' + Date.now() + '.json');

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
    c.wait = (pred, ms = 8000) => new Promise((res, rej) => {
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
      assert.strictEqual(r.t, 'deckSaved', r.msg); await c.wait(m => m.t === 'me');
      return r.id;
    }
    c.send({ t: 'buyPack', kind: 'std' }); await c.wait(m => m.t === 'me');
  }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_FILE, DATABASE_URL: '', TURN_LIMIT_MS: '4000' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('działa')) r(); }));
  try {
    const a = await client('juli'), b = await client('olaf');
    for (const c of [a, b]) { c.send({ t: 'login', username: c.name, password: 'haslo' }); await c.wait(m => m.t === 'auth'); }
    const da = await buildDeck(a), db = await buildDeck(b);
    a.send({ t: 'challenge', to: b.me.id, deckId: da });
    const ch = await b.wait(m => m.t === 'challenged');
    b.send({ t: 'acceptChallenge', from: ch.from, deckId: db });
    await a.wait(m => m.t === 'game'); await b.wait(m => m.t === 'game');
    a.send({ t: 'act', action: { type: 'mulligan', uids: [] } }); b.send({ t: 'act', action: { type: 'mulligan', uids: [] } });
    const v0 = (await a.wait(m => m.t === 'game' && m.view.phase === 'play')).view;
    assert(v0.turnLeftMs > 0 && v0.turnLeftMs <= 4000, 'widok podaje pozostały czas tury');
    assert.strictEqual(v0.turnLimitMs, 4000);
    // emotki: gotowe i własne (przycięte do 40 znaków), limit częstotliwości
    a.send({ t: 'emote', text: 'O ty chuju' });
    const e1 = await b.wait(m => m.t === 'emote');
    assert.strictEqual(e1.text, 'O ty chuju'); assert.strictEqual(e1.seat, v0.mySeat);
    a.send({ t: 'emote', text: 'spam' });
    await new Promise(r => setTimeout(r, 300));
    assert(!b.inbox.some(m => m.t === 'emote' && m.text === 'spam'), 'limit emotek');
    await new Promise(r => setTimeout(r, 1300));
    b.send({ t: 'emote', text: '  <b>' + 'x'.repeat(80) + '  ' });
    const e2 = await a.wait(m => m.t === 'emote');
    assert(e2.text.length <= 40 && !e2.text.includes('<'), 'własna emotka oczyszczona');
    console.log('✓ emotki trafiają do przeciwnika (z limitem i czyszczeniem tekstu)');
    const first = v0.currentSeat;
    const v1 = (await a.wait(m => m.t === 'game' && m.view.phase === 'play' && m.view.currentSeat !== first, 8000)).view;
    assert(v1.turnNo > v0.turnNo);
    console.log('✓ po upływie limitu tura przechodzi sama na przeciwnika');
    const v2 = (await a.wait(m => m.t === 'game' && m.view.currentSeat === first && m.view.turnNo > v1.turnNo, 8000)).view;
    assert(v2.turnNo > v1.turnNo);
    console.log('✓ limit działa w kolejnych turach');
    console.log('\nTest limitu tury zaliczony.');
  } catch (e) {
    console.error('BŁĄD:', e); process.exitCode = 1;
  } finally {
    srv.kill();
    try { fs.unlinkSync(DATA_FILE); } catch { }
    process.exit(process.exitCode || 0);
  }
})();
