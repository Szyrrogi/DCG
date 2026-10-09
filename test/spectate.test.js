// Test: wcześniejsza wypłata bonusu i tryb obserwatora.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3991;
const DATA_FILE = path.join(os.tmpdir(), 'dcg-spec-' + Date.now() + '.json');
const SERVER = path.join(__dirname, '..', 'server', 'index.js');

function startServer() {
  const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT, DATA_FILE, DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('działa')) r(srv); }));
}
function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { ws, inbox: [], waiters: [], me: null, market: null };
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'me' || m.t === 'auth') c.me = m.me;
      if (m.t === 'market') c.market = m;
      c.inbox.push(m);
      c.waiters = c.waiters.filter(w => { if (w.pred(m)) { w.res(m); return false; } return true; });
    });
    ws.on('open', () => resolve(c)); ws.on('error', reject);
    c.send = m => ws.send(JSON.stringify(m));
    c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
      const i = c.inbox.findIndex(pred);
      if (i >= 0) return res(c.inbox.splice(i, 1)[0]);
      const t = setTimeout(() => rej(new Error('timeout')), ms);
      c.waiters.push({ pred, res: m => { clearTimeout(t); c.inbox.splice(c.inbox.indexOf(m), 1); res(m); } });
    });
    c.clear = () => { c.inbox.length = 0; };
  });
}
async function login(name) {
  const c = await client();
  c.send({ t: 'login', username: name, password: 'haslo' });
  await c.wait(m => m.t === 'auth'); await c.wait(m => m.t === 'market');
  return c;
}
const deckOf = (base, extra) => { const d = [...extra]; for (const n of base) { while (d.length < 20 && d.filter(x => x === n).length < 3) d.push(n); } return d; };

(async () => {
  let srv = await startServer(); srv.kill(); await new Promise(r => setTimeout(r, 300));
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const filler = ['Eva', 'Grzesiek', 'Natis', 'Yeager', 'Tael', 'Runia', 'Ksawery'];
  const U = n => db.users.find(u => u.username === n);
  for (const n of ['szyrrogi', 'juli']) Object.assign(U(n), { collection: Object.fromEntries(filler.map(x => [x, 3])), decks: [{ id: 'd' + n, name: 'T', cards: deckOf(filler, []) }] });
  U('olaf').defeated = [U('juli').id, U('tofame').id, U('massyn').id, U('jędrek').id];
  U('tofame').defeated = [U('juli').id, U('olaf').id];
  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  srv = await startServer();
  try {
    const A = await login('szyrrogi'), B = await login('juli'), O = await login('olaf'), T = await login('tofame');

    T.send({ t: 'cashOut' });
    assert.match((await T.wait(m => m.t === 'error')).msg, /3\/5 albo 4\/5/);
    const g0 = O.me.gold;
    O.send({ t: 'cashOut' });
    const me = (await O.wait(m => m.t === 'me')).me;
    assert.strictEqual(me.gold, g0 + 60); assert.deepStrictEqual(me.defeated, []);
    console.log('✓ wypłata przy 4/5 daje 60 złota i resetuje serię, przy 2/5 nie można');

    A.send({ t: 'challenge', to: B.me.id, deckId: 'dszyrrogi' });
    const ch = await B.wait(m => m.t === 'challenged');
    B.send({ t: 'acceptChallenge', from: ch.from, deckId: 'djuli' });
    const va = (await A.wait(m => m.t === 'game')).view; const vb = (await B.wait(m => m.t === 'game')).view;
    const starter = va.currentSeat === va.mySeat ? va : vb, other = starter === va ? vb : va;
    assert.strictEqual(starter.me.hand.length, 3); assert.strictEqual(other.me.hand.length, 4);
    console.log('✓ zaczynający ma 3 karty, drugi gracz 4');

    O.send({ t: 'spectate', userId: A.me.id });
    const sv = (await O.wait(m => m.t === 'game')).view;
    assert(sv.spectator); assert.strictEqual(sv.me.hand.length + sv.opp.hand.length, 7);
    await A.wait(m => m.t === 'toast' && /ogląda/.test(m.msg));
    O.send({ t: 'act', action: { type: 'end' } });
    assert.match((await O.wait(m => m.t === 'error')).msg, /Nie jesteś w grze/);
    A.send({ t: 'act', action: { type: 'mulligan', uids: [] } });
    await O.wait(m => m.t === 'game' && m.view.mulligan && (m.view.mulligan.me || m.view.mulligan.opp));
    console.log('✓ obserwator widzi ręce obu graczy, dostaje aktualizacje i nie może grać');

    B.send({ t: 'act', action: { type: 'concede' } });
    const end = await O.wait(m => m.t === 'spectateEnd');
    assert.strictEqual(end.winner, 'szyrrogi');
    console.log('✓ obserwator dostaje wynik meczu');
    console.log('\nTest obserwatora i wypłaty zaliczony.');
  } catch (e) {
    console.error('BŁĄD:', e); process.exitCode = 1;
  } finally {
    srv.kill(); try { fs.unlinkSync(DATA_FILE); } catch { }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
