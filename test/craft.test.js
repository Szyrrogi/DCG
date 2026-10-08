// Test wytwarzania: rozbijanie na pył, wytwarzanie, pustki w taliach, karty na rynku.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3993;
const DATA_FILE = path.join(os.tmpdir(), 'dcg-craft-' + Date.now() + '.json');
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
  Object.assign(U('szyrrogi'), { collection: { ...Object.fromEntries(filler.map(n => [n, 3])), '67': 5, Agnieszka: 1, Massyn: 1 }, decks: [{ id: 'dA', name: 'Talia A', cards: deckOf(filler, ['Agnieszka']) }] });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  srv = await startServer();
  try {
    const A = await login('szyrrogi');
    assert.strictEqual(A.me.dust, 0);
    assert.deepStrictEqual(A.me.rules.dust.craft, { 1: 40, 2: 100, 3: 400 });

    A.send({ t: 'craft', name: 'Olaf' });
    assert.match((await A.wait(m => m.t === 'error')).msg, /Za mało pyłu/);

    A.send({ t: 'disenchant', cards: { '67': 6 } });
    assert.match((await A.wait(m => m.t === 'error')).msg, /najwyżej 5/);
    A.send({ t: 'disenchant', cards: { '67': 2, Massyn: 1 } });
    const r = await A.wait(m => m.t === 'crafted');
    assert.strictEqual(r.dust, 2 * 5 + 100);
    const me1 = (await A.wait(m => m.t === 'me')).me;
    assert.strictEqual(me1.dust, 110); assert.strictEqual(me1.collection['67'], 3); assert.strictEqual(me1.collection.Massyn, 0);
    console.log('✓ rozbijanie daje pył (5 / 20 / 100) i nie pozwala rozbić więcej niż masz');

    A.send({ t: 'disenchant', name: 'Agnieszka', count: 1 });
    await A.wait(m => m.t === 'crafted');
    const me2 = (await A.wait(m => m.t === 'me')).me;
    assert.strictEqual(me2.dust, 130);
    assert.strictEqual(me2.decks[0].cards.length, 19);
    await A.wait(m => m.t === 'toast' && /puste miejsce/.test(m.msg));
    console.log('✓ rozbicie karty z talii zostawia puste miejsce');

    A.send({ t: 'craft', name: 'Szymon' });
    const c = await A.wait(m => m.t === 'crafted');
    assert.strictEqual(c.name, 'Szymon');
    const me3 = (await A.wait(m => m.t === 'me')).me;
    assert.strictEqual(me3.dust, 30); assert.strictEqual(me3.collection.Szymon, 1);
    console.log('✓ wytwarzanie wybranej karty za pył');

    A.send({ t: 'marketPost', give: 'Eva', want: 'Grzesiek' }); await A.wait(m => m.t === 'toast');
    A.send({ t: 'disenchant', cards: { Eva: 3 } });
    assert.match((await A.wait(m => m.t === 'error')).msg, /najwyżej 2/);
    console.log('✓ nie można rozbić kopii wystawionej na rynku');

    console.log('\nTest wytwarzania zaliczony.');
  } catch (e) {
    console.error('BŁĄD:', e); process.exitCode = 1;
  } finally {
    srv.kill(); try { fs.unlinkSync(DATA_FILE); } catch { }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
