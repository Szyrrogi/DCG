// Test Przygody: gry z komputerem przez WebSocket, nagrody za bossów i bota treningowego,
// darmowy draft, ukryta karta Kunnera niedostępna dla graczy.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3997;
const DATA_FILE = path.join(os.tmpdir(), 'dcg-bots-' + Date.now() + '.json');

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { ws, name, inbox: [], waiters: [], me: null, view: null, cards: null };
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'me' || m.t === 'auth') c.me = m.me;
      if (m.t === 'auth') { c.cards = m.cards; c.bots = m.bots; }
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
      assert.strictEqual(r.t, 'deckSaved', r.msg);
      await c.wait(m => m.t === 'me');
      return r.id;
    }
    c.send({ t: 'buyPack', kind: 'std' }); await c.wait(m => m.t === 'me');
  }
}

function chooseMove(v) {
  const me = v.me;
  if (v.pending && v.pending.mine) {
    if (v.pending.type === 'discard') return { type: 'choose', uid: me.hand[0].uid };
    if (v.pending.type === 'target') return { type: 'choose', uid: v.pending.options[0] };
    return { type: 'choiceIndex', index: 0 };
  }
  if (!me.manaActionUsed) { const c = ['T', 'W', 'B'].sort((a, b) => me.mana[a].lvl - me.mana[b].lvl)[0]; if (me.mana[c].lvl < 4) return { type: 'mana', city: c }; }
  const p = me.hand.find(c => c.playable);
  if (p) return { type: 'play', uid: p.uid, target: v.opp.board[0] && v.opp.board[0].uid };
  const u = me.board.find(x => x.canAttack);
  if (u) return { type: 'attack', uid: u.uid, target: v.opp.board.some(x => x.taunt) ? v.opp.board.find(x => x.taunt).uid : 'hero' };
  return { type: 'end' };
}

async function playBot(c, deckId, bot) {
  c.view = null; c.inbox.length = 0;
  c.send({ t: 'startBot', bot, deckId });
  await c.wait(m => m.t === 'game');
  c.send({ t: 'act', action: { type: 'mulligan', uids: [] } });
  let guard = 0, sawBossEvent = false;
  for (;;) {
    if (++guard > 4000) throw new Error('gra z botem się nie kończy');
    const over = c.inbox.find(m => m.t === 'gameOver');
    if (over) { c.inbox.splice(c.inbox.indexOf(over), 1); await c.wait(m => m.t === 'me'); return { over, sawBossEvent }; }
    const v = c.view;
    if (v && (v.events || []).some(e => e.by !== v.mySeat)) sawBossEvent = true;
    if (v && !v.over && v.phase === 'play' && (v.myTurn || (v.pending && v.pending.mine))) {
      const seq = v.seq;
      c.send({ t: 'act', action: chooseMove(v) });
      const r = await c.wait(m => (m.t === 'game' && m.view.seq > seq) || m.t === 'error' || m.t === 'gameOver');
      if (r.t === 'gameOver') { c.inbox.push(r); continue; }
      if (r.t === 'error') { c.send({ t: 'act', action: { type: 'end' } }); await c.wait(m => m.t === 'game' || m.t === 'gameOver').then(x => { if (x.t === 'gameOver') c.inbox.push(x); }); }
    } else {
      await c.wait(m => m.t === 'game' || m.t === 'gameOver', 15000).then(x => { if (x.t === 'gameOver') c.inbox.push(x); });
    }
  }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_FILE, DATABASE_URL: '', BOT_DELAY_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('działa')) r(); }));
  try {
    const c = await client('olaf');
    c.send({ t: 'login', username: 'olaf', password: 'haslo' });
    await c.wait(m => m.t === 'auth');
    assert.deepStrictEqual(c.bots.map(b => b.id), ['casborg', 'kunner', 'tczew', 'trener']);
    assert(c.cards.find(x => x.name === 'Wyrok Kunnera').hidden, 'karta Kunnera musi być ukryta');
    const deckId = await buildDeck(c);
    console.log('✓ lista przeciwników i talia gotowe');

    c.send({ t: 'craft', name: 'Wyrok Kunnera' });
    assert.match((await c.wait(m => m.t === 'error')).msg, /Nieznana/);
    console.log('✓ Wyroku Kunnera nie da się wytworzyć');

    const gold0 = c.me.gold;
    c.send({ t: 'draftStart' });
    await c.wait(m => m.t === 'draftState');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(c.me.gold, gold0, 'draft musi być darmowy');
    console.log('✓ draft jest darmowy');

    for (const bot of ['casborg', 'kunner', 'tczew', 'trener']) {
      const before = c.me.gold, prev = (c.me.adventure[bot] || { wins: 0 }).wins;
      const { over, sawBossEvent } = await playBot(c, deckId, bot);
      assert(sawBossEvent, 'brak zdarzeń bota w dzienniku');
      const kind = bot === 'trener' ? 'training' : 'adventure';
      if (over.result === 'win') {
        const want = kind === 'training' ? 5 : prev ? 10 : 30;
        assert.strictEqual(over.reward.gold, want); assert.strictEqual(c.me.gold, before + want);
      } else {
        assert.strictEqual(over.reward.gold, 0); assert.strictEqual(c.me.gold, before);
      }
      assert.strictEqual(c.me.adventure[bot].wins + c.me.adventure[bot].losses, 1);
      console.log(`✓ ${bot}: ${over.result === 'win' ? 'wygrana +' + over.reward.gold : 'porażka'} (nagroda poprawna)`);
    }

    // poddanie w grze z botem kończy grę bez nagrody
    c.send({ t: 'startBot', bot: 'trener', deckId });
    await c.wait(m => m.t === 'game');
    c.send({ t: 'act', action: { type: 'concede' } });
    const r = await c.wait(m => m.t === 'gameOver');
    assert.strictEqual(r.result, 'loss'); assert.strictEqual(r.reward.gold, 0);
    console.log('✓ poddanie się z botem');
    console.log('\nTest przygody zaliczony.');
  } catch (e) {
    console.error('BŁĄD:', e); process.exitCode = 1;
  } finally {
    srv.kill();
    try { fs.unlinkSync(DATA_FILE); } catch { }
    process.exit(process.exitCode || 0);
  }
})();
