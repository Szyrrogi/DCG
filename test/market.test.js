// Test rynku wymiany: oferty, rzadkość, przyjmowanie, auto-dopasowanie, pustki w taliach.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3996;
const DATA_FILE = path.join(os.tmpdir(), 'dcg-market-' + Date.now() + '.json');
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
  // 1. utwórz konta, potem wstrzyknij znane kolekcje i talie
  let srv = await startServer(); srv.kill(); await new Promise(r => setTimeout(r, 300));
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const filler = ['Eva', 'Grzesiek', 'Natis', 'Yeager', 'Tael', 'Runia', 'Ksawery'];
  const base = Object.fromEntries(filler.map(n => [n, 3]));
  const U = n => db.users.find(u => u.username === n);
  Object.assign(U('szyrrogi'), { collection: { ...base, '67': 1, Lian: 1 }, decks: [{ id: 'dA', name: 'Talia A', cards: deckOf(filler, ['67']) }] });
  Object.assign(U('juli'), { collection: { ...base, Kubba: 1 }, decks: [{ id: 'dB', name: 'Talia B', cards: deckOf(filler, ['Kubba']) }] });
  Object.assign(U('olaf'), { collection: { Julka: 1 }, decks: [] });
  Object.assign(U('tofame'), { collection: { Gustav: 1, Lian: 1 }, decks: [] });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  srv = await startServer();
  try {
    const A = await login('szyrrogi'), B = await login('juli'), C = await login('olaf'), D = await login('tofame');

    A.send({ t: 'marketPost', give: '67', want: 'Agnieszka' });
    assert.match((await A.wait(m => m.t === 'error')).msg, /rzadkości/);
    A.send({ t: 'marketPost', give: 'Massyn', want: 'Olaf' });
    assert.match((await A.wait(m => m.t === 'error')).msg, /wolnej kopii/);
    console.log('✓ tylko ta sama rzadkość i tylko posiadane karty');

    A.send({ t: 'marketPost', give: '67', want: 'Kubba' });
    await A.wait(m => m.t === 'toast' && /wystawiona/.test(m.msg));
    A.send({ t: 'marketPost', give: '67', want: 'Eva' });
    assert.match((await A.wait(m => m.t === 'error')).msg, /wolnej kopii/);
    const offer = (await B.wait(m => m.t === 'market' && m.offers.length === 1)).offers[0];
    assert.strictEqual(offer.username, 'szyrrogi');
    console.log('✓ oferta widoczna dla innych, nie można oddać tej samej kopii dwa razy');

    C.send({ t: 'marketAccept', id: offer.id });
    assert.match((await C.wait(m => m.t === 'error')).msg, /Nie masz/);

    A.clear(); B.clear();
    B.send({ t: 'marketAccept', id: offer.id });
    const meA = (await A.wait(m => m.t === 'me')).me;
    const meB = (await B.wait(m => m.t === 'me')).me;
    assert.strictEqual(meA.collection['67'], 0); assert.strictEqual(meA.collection.Kubba, 1);
    assert.strictEqual(meB.collection.Kubba, 0); assert.strictEqual(meB.collection['67'], 1);
    assert.strictEqual(meA.decks[0].cards.length, 19); assert(!meA.decks[0].cards.includes('67'));
    assert.strictEqual(meB.decks[0].cards.length, 19); assert(!meB.decks[0].cards.includes('Kubba'));
    assert((await A.wait(m => m.t === 'toast' && /puste miejsce/.test(m.msg))).msg.includes('Talia A'));
    console.log('✓ wymiana przenosi karty, w taliach zostają pustki (19/20) + powiadomienie');

    const bDeck = meB.decks[0];
    B.send({ t: 'challenge', to: meA.id, deckId: bDeck.id });
    assert.match((await B.wait(m => m.t === 'error')).msg, /niepoprawna/);
    B.send({ t: 'saveDeck', id: bDeck.id, name: bDeck.name, cards: [...bDeck.cards, '67'] });
    await B.wait(m => m.t === 'deckSaved');
    console.log('✓ talia z pustką nie nadaje się do gry, po uzupełnieniu działa');

    // auto-dopasowanie: tofame oddaje Gustav za Julkę, olaf oddaje Julkę za Gustava
    D.send({ t: 'marketPost', give: 'Gustav', want: 'Julka' });
    await D.wait(m => m.t === 'toast');
    C.clear(); D.clear();
    C.send({ t: 'marketPost', give: 'Julka', want: 'Gustav' });
    const meC = (await C.wait(m => m.t === 'me')).me;
    assert.strictEqual(meC.collection.Gustav, 1); assert.strictEqual(meC.collection.Julka, 0);
    const mk = await C.wait(m => m.t === 'market' && !m.offers.some(o => o.give === 'Gustav'));
    assert(mk.trades[0].give === 'Gustav');
    console.log('✓ odwrotne oferty wymieniają się automatycznie');

    // gdy karta odejdzie inną drogą, jej oferta znika
    D.send({ t: 'marketPost', give: 'Lian', want: 'Tael' });
    await D.wait(m => m.t === 'toast');
    A.send({ t: 'marketPost', give: 'Kubba', want: 'Lian' });
    await A.wait(m => m.t === 'toast');
    const o2 = (await D.wait(m => m.t === 'market' && m.offers.some(o => o.give === 'Kubba'))).offers.find(o => o.give === 'Kubba');
    D.clear();
    D.send({ t: 'marketAccept', id: o2.id });
    const after = await D.wait(m => m.t === 'market' && !m.offers.some(o => o.give === 'Kubba'));
    assert(!after.offers.some(o => o.give === 'Lian'), 'oferta z Lianem powinna zniknąć');
    console.log('✓ oferty kart, których już nie masz, są wycofywane');

    A.clear();
    A.send({ t: 'marketPost', give: 'Eva', want: 'Grzesiek' });
    await A.wait(m => m.t === 'toast');
    const mine = (await A.wait(m => m.t === 'market' && m.offers.some(o => o.give === 'Eva'))).offers.find(o => o.give === 'Eva');
    B.send({ t: 'marketCancel', id: mine.id }); // cudza – nic się nie dzieje
    A.send({ t: 'marketCancel', id: mine.id });
    await A.wait(m => m.t === 'market' && !m.offers.some(o => o.id === mine.id));
    console.log('✓ wycofanie oferty (tylko własnej)');

    await new Promise(r => setTimeout(r, 500));
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    assert(saved.trades.length >= 3);
    console.log('\nTest rynku zaliczony.');
  } catch (e) {
    console.error('BŁĄD:', e); process.exitCode = 1;
  } finally {
    srv.kill(); try { fs.unlinkSync(DATA_FILE); } catch { }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
