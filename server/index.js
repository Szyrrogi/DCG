// Serwer gry: konta, złoto, paczki, kolekcja, talie, lobby i walki 1v1 przez WebSocket.
'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game, GameError, CARDS, BY_NAME } = require('./engine');
const { createStore } = require('./store');
const AI = require('./ai');
const { BOTS, REWARDS, botSeat, publicBots } = require('./bots');

// ukryte zdolności nie trafiają do klienta (Gustav znika, Lazarus wraca)
const PUBLIC_CARDS = CARDS.map(c => {
  if (c.hiddenDeath) return { ...c, turnsUntilDeath: -1, hiddenDeath: undefined };
  if (c.passive === 'ReviveOnce') return { ...c, passive: '' };
  return c;
});

const PORT = process.env.PORT || 3000;
const WIN_GOLD = 10;
const BONUS_GOLD = 100;
const BONUS_DISTINCT = 5;
const DECK_SIZE = 20;
const DRAFT_COST = 0; // drafty są darmowe
const PACKS = { std: { price: 50, label: 'Zwykła paczka' }, leg: { price: 500, label: 'Legendarna paczka' } };
const START = { gold: 1000, std: 5, leg: 1 };
const ACCOUNTS = [
  ['szyrrogi', 'f3', ['igor']], ['juli', 'f1', []], ['tofame', 'f5', []],
  ['olaf', 'f4', []], ['jędrek', 'f2', []], ['massyn', 'f6', []],
];
const ADMINS = (process.env.ADMINS || 'szyrrogi').split(',').map(s => norm(s)).filter(Boolean);
const MAX_ACCOUNTS = 60;
const FACES = 9;
const MAX_OFFERS_PER_USER = 10;
const CASH_OUT = { 3: 30, 4: 60 };
const DUST = { disenchant: { 1: 5, 2: 20, 3: 100 }, craft: { 1: 40, 2: 100, 3: 400 } };
const DEFAULT_PASSWORD = 'haslo';
const FORFEIT_AFTER_MS = 60_000;
const TURN_LIMIT_MS = Number(process.env.TURN_LIMIT_MS || 67_000); // limit tury w grze online (67 s)

const store = createStore();
let db = null;
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(db).catch(e => console.error('Błąd zapisu:', e)), 300);
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const h = crypto.scryptSync(pw, user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}
function norm(n) { return String(n || '').trim().toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function validAvatar(a) {
  if (typeof a === 'number') a = 'f' + a;
  if (typeof a !== 'string') return null;
  const m = /^f(\d+)$/.exec(a);
  if (m) return +m[1] >= 1 && +m[1] <= FACES ? a : null;
  if (a.startsWith('c:') && BY_NAME[a.slice(2)]) return a;
  return null;
}
function newUser(name, avatar, password = DEFAULT_PASSWORD) {
  const { salt, hash } = hashPassword(password);
  return {
    id: 'u' + crypto.randomBytes(5).toString('hex'), username: name, salt, hash, avatar,
    gold: START.gold, dust: 0, packs: { std: START.std, leg: START.leg },
    collection: {}, decks: [], defeated: [], draft: null, draftStreak: 0, adventure: {},
    stats: { wins: 0, losses: 0, bonuses: 0 }, sessions: [],
  };
}

async function loadDb() {
  db = (await store.load()) || { users: [], history: [], market: [], trades: [], draftLeaderboard: [] };
  db.users = db.users || []; db.history = db.history || []; db.market = db.market || []; db.trades = db.trades || []; db.draftLeaderboard = db.draftLeaderboard || [];
  for (const u of db.users) { u.avatar = validAvatar(u.avatar) || 'f1'; if (typeof u.dust !== 'number') u.dust = 0; if (!u.adventure || typeof u.adventure !== 'object') u.adventure = {}; }
  for (const [name, avatar, old] of ACCOUNTS) {
    const keys = [norm(name), ...old.map(norm)];
    const existing = db.users.find(u => keys.includes(norm(u.username)));
    if (existing) existing.username = name; else db.users.push(newUser(name, avatar));
  }
  await store.save(db);
}

const userById = id => db.users.find(u => u.id === id);
const userByName = n => db.users.find(u => norm(u.username) === norm(n));
const isAdmin = u => ADMINS.includes(norm(u.username));

function publicProfile(u) {
  return {
    id: u.id, username: u.username, avatar: u.avatar, gold: u.gold, dust: u.dust, packs: u.packs,
    collection: u.collection, decks: u.decks, defeated: u.defeated, stats: u.stats, isAdmin: isAdmin(u),
    adventure: u.adventure || {},
    rules: { winGold: WIN_GOLD, bonusGold: BONUS_GOLD, bonusDistinct: BONUS_DISTINCT, deckSize: DECK_SIZE, packs: PACKS, dust: DUST, cashOut: CASH_OUT, draftCost: DRAFT_COST },
  };
}

function randomByRarity(r) {
  // Blokujemy tokeny Wąż i Smok przed wypadaniem z paczek
  const pool = CARDS.filter(c => c.rarity === r && !c.token && c.name !== 'Wąż' && c.name !== 'Smok');
  return pool[Math.floor(Math.random() * pool.length)];
}
function rollCard() {
  const roll = Math.random() * 100;
  if (roll <= 1) return randomByRarity(3);
  if (roll <= 11) return randomByRarity(2);
  return randomByRarity(1);
}

function trimDecks(u) {
  const removed = [];
  for (const d of u.decks) {
    const cnt = {};
    d.cards = d.cards.filter(n => {
      cnt[n] = (cnt[n] || 0) + 1;
      if (cnt[n] > (u.collection[n] || 0)) { removed.push({ deck: d.name, card: n }); return false; }
      return true;
    });
  }
  return removed;
}
const userOffers = u => db.market.filter(o => o.userId === u.id);
const offeredCount = (u, name) => userOffers(u).filter(o => o.give === name).length;
function cleanupOffers(u) {
  let changed = false;
  for (const name of new Set(userOffers(u).map(o => o.give))) {
    let extra = offeredCount(u, name) - (u.collection[name] || 0);
    while (extra-- > 0) {
      let idx = -1;
      db.market.forEach((o, i) => { if (o.userId === u.id && o.give === name) idx = i; });
      db.market.splice(idx, 1); changed = true;
    }
  }
  return changed;
}
function marketState() {
  return {
    offers: db.market.map(o => { const u = userById(o.userId); return { ...o, username: u ? u.username : '?', avatar: u ? u.avatar : 'f1' }; }),
    trades: db.trades.slice(-20).reverse(),
  };
}
function broadcastMarket() {
  const m = { t: 'market', ...marketState() };
  for (const ws of sockets.values()) send(ws, m);
}
function afterCollectionLoss(u) {
  cleanupOffers(u);
  const removed = trimDecks(u);
  if (removed.length) {
    const txt = removed.map(r => `„${r.deck}”: ${r.card}`).join(', ');
    sendTo(u.id, { t: 'toast', msg: `Karta odeszła z kolekcji – puste miejsce w talii ${txt}.` });
  }
}
function executeTrade(offer, taker) {
  const maker = userById(offer.userId);
  db.market = db.market.filter(o => o !== offer);
  maker.collection[offer.give]--; maker.collection[offer.want] = (maker.collection[offer.want] || 0) + 1;
  taker.collection[offer.want]--; taker.collection[offer.give] = (taker.collection[offer.give] || 0) + 1;
  db.trades.push({ at: Date.now(), maker: maker.username, taker: taker.username, give: offer.give, want: offer.want });
  if (db.trades.length > 200) db.trades.shift();
  for (const u of [maker, taker]) afterCollectionLoss(u);
  scheduleSave();
  sendTo(maker.id, { t: 'toast', msg: `${taker.username} przyjął Twoją ofertę: oddajesz ${offer.give}, dostajesz ${offer.want}!` });
  sendTo(taker.id, { t: 'toast', msg: `Wymiana z ${maker.username}: oddajesz ${offer.want}, dostajesz ${offer.give}!` });
  sendMe(maker); sendMe(taker); broadcastMarket();
}

function validateDeck(u, cards) {
  if (!Array.isArray(cards)) return 'Zła talia.';
  if (cards.length !== DECK_SIZE) return `Talia musi mieć dokładnie ${DECK_SIZE} kart (ma ${cards.length}).`;
  const counts = {};
  for (const n of cards) { if (!BY_NAME[n]) return `Nieznana karta: ${n}`; counts[n] = (counts[n] || 0) + 1; }
  for (const [n, k] of Object.entries(counts)) {
    const max = BY_NAME[n].rarity === 1 ? 3 : 1;
    if (k > max) return `${n}: maksymalnie ${max} w talii.`;
    if (k > (u.collection[n] || 0)) return `Masz tylko ${u.collection[n] || 0}× ${n}.`;
  }
  return null;
}

// ---------------- draft logic ----------------
function generateDraftChoices(round) {
    let r = 1, type = 'unit';
    if (round === 1) r = 3;
    else if (round <= 3) r = 2;
    else if (round >= 9) { r = 1; type = 'spell'; }
    
    // Blokujemy tokeny przed pojawianiem się w Drafcie
    let pool = CARDS.filter(c => c.rarity === r && c.type === type && !c.token && c.name !== 'Wąż' && c.name !== 'Smok');
    if (pool.length < 3) pool = CARDS.filter(c => c.rarity === r && !c.token && c.name !== 'Wąż' && c.name !== 'Smok');
    return pool.sort(() => Math.random() - 0.5).slice(0, 3).map(c => c.name);
}

// ---------------- połączenia ----------------
const sockets = new Map();
const games = new Map();
const userGame = new Map();
const challenges = new Map();
const offlineSince = new Map();
const spectators = new Map();

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendTo(userId, msg) { send(sockets.get(userId), msg); }
function sendMe(u) { sendTo(u.id, { t: 'me', me: publicProfile(u) }); }

function lobbyState() {
  return db.users.map(u => ({
    id: u.id, username: u.username, avatar: u.avatar, online: sockets.has(u.id),
    inGame: userGame.has(u.id), stats: u.stats, gold: u.gold, defeatedCount: u.defeated.length,
    watchers: userGame.has(u.id) ? (spectators.get(userGame.get(u.id)) || new Set()).size : 0,
    opponent: userGame.has(u.id) ? (games.get(userGame.get(u.id)) || { players: [] }).players.map(p => p.name).find(n => n !== u.username) || null : null,
    draftStreak: u.draftStreak || 0, hasDraftDeck: !!(u.draft && u.draft.ready)
  }));
}
function broadcastLobby() {
  const players = lobbyState();
  const ch = [...challenges.entries()].map(([from, c]) => ({ from, to: c.to, isDraft: !!c.isDraft }));
  const draftLeaderboard = (db.draftLeaderboard || []).slice(0, 10);
  for (const [id, ws] of sockets) send(ws, { t: 'lobby', players, challenges: ch.filter(c => c.from === id || c.to === id), history: db.history.slice(-15).reverse(), draftLeaderboard });
}

function spectatorOf(userId) {
  for (const [gid, set] of spectators) if (set.has(userId)) return gid;
  return null;
}
function stopSpectating(userId) {
  for (const [gid, set] of spectators) { set.delete(userId); if (!set.size) spectators.delete(gid); }
}
function sendGame(g) {
  g.players.forEach((p, i) => { if (!p.isBot) sendTo(p.userId, { t: 'game', view: g.view(i) }); });
  const set = spectators.get(g.id);
  if (set && set.size) { const sv = g.spectatorView(); for (const id of set) sendTo(id, { t: 'game', view: sv }); }
  scheduleBot(g);
  armTurnTimer(g);
}

// ---------------- limit czasu tury (gry online) ----------------
function armTurnTimer(g) {
  if (!g.turnLimitMs || g.over || g.phase !== 'play') return;
  const key = g.turnNo;
  if (g.timerKey === key) return;
  clearTimeout(g.turnTimer);
  g.timerKey = key;
  g.turnTimer = setTimeout(() => onTurnTimeout(g, key), Math.max(0, g.turnStartedAt + g.turnLimitMs - Date.now()) + 250);
}
function onTurnTimeout(g, key) {
  if (g.over || g.turnNo !== key || !games.has(g.id)) return;
  const i = g.current;
  try {
    // niedokończone wybory rozstrzygamy losowo, potem koniec tury
    let guard = 0;
    while (g.pending && g.pending.player === i && guard++ < 10) {
      const q = g.pending, p = g.players[i];
      if (q.type === 'discard') g.action(i, { type: 'choose', uid: g.pick(p.hand).uid });
      else if (q.type === 'target') g.action(i, { type: 'choose', uid: g.pick(q.options) });
      else g.action(i, { type: 'choiceIndex', index: Math.floor(Math.random() * q.options.length) });
    }
    if (!g.over && g.current === i && g.turnNo === key) {
      g.say(`${g.players[i].name} – czas minął!`);
      g.action(i, { type: 'end' });
    }
  } catch (e) { console.error('Limit tury:', e); }
  sendGame(g);
  if (g.over) settleGame(g);
}

// ---------------- przeciwnik komputerowy ----------------
const BOT_SPEED = Math.max(0, Number(process.env.BOT_DELAY_SCALE || 1)); // testy: 0.01
const BOT_DELAY = { mulligan: 1400, mana: 650, play: 1350, attack: 1150, end: 900, choose: 1000, choiceIndex: 1000 };
function scheduleBot(g) {
  if (!g.bot || g.over || g.botTimer) return;
  const seat = g.players.findIndex(p => p.isBot);
  let a;
  try { a = AI.decide(g, seat); } catch (e) { console.error('AI:', e); a = g.current === seat && !g.pending ? { type: 'end' } : null; }
  if (!a) return;
  const wait = ((BOT_DELAY[a.type] || 1000) + (g.turnFresh ? 700 : 0)) * BOT_SPEED;
  g.turnFresh = false;
  g.botTimer = setTimeout(() => {
    g.botTimer = null;
    if (g.over || !games.has(g.id)) return;
    const before = g.current;
    let now;
    try { now = AI.decide(g, seat); } catch (e) { console.error('AI:', e); now = g.current === seat && !g.pending && g.phase === 'play' ? { type: 'end' } : null; }
    if (!now) return;
    try { g.action(seat, now); } catch (e) {
      if (!(e instanceof GameError)) console.error('AI:', e);
      try { if (g.current === seat && !g.pending && g.phase === 'play') g.action(seat, { type: 'end' }); } catch { }
    }
    if (g.current === seat && before !== seat) g.turnFresh = true;
    sendGame(g);
    if (g.over) settleGame(g);
  }, wait);
}

function startBotGame(u, deck, bot) {
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const g = new Game(id, [
    { userId: u.id, name: u.username, avatar: u.avatar, deck: deck.cards },
    botSeat(bot),
  ]);
  g.bot = bot.id;
  g.isDraft = false;
  g.current = bot.botStarts ? 1 : 0; // z botem zaczyna gracz (poza Maestro)
  if (bot.flatCost != null) g.flatCost = bot.flatCost;
  g.start();
  g.mulliganEndsAt = Date.now() + 40_000;
  g.turnFresh = true;
  setTimeout(() => { if (g.phase === 'mulligan' && !g.over) { g.autoMulligan(); sendGame(g); } }, 40_500);
  games.set(id, g);
  userGame.set(u.id, id);
  stopSpectating(u.id);
  for (const k of [...challenges.keys()]) { const c = challenges.get(k); if (k === u.id || c.to === u.id) challenges.delete(k); }
  sendGame(g); broadcastLobby();
}

function settleBotGame(g) {
  const humanSeat = g.players.findIndex(p => !p.isBot);
  const u = userById(g.players[humanSeat].userId);
  const bot = BOTS[g.bot];
  if (g.botTimer) { clearTimeout(g.botTimer); g.botTimer = null; }
  userGame.delete(u.id);
  const won = g.winner === humanSeat;
  const rec = u.adventure[bot.id] || (u.adventure[bot.id] = { wins: 0, losses: 0 });
  let gold = 0, first = false;
  if (won) {
    first = !rec.wins;
    gold = first ? REWARDS[bot.kind].first : REWARDS[bot.kind].win;
    rec.wins++; u.gold += gold;
  } else rec.losses++;
  scheduleSave();
  sendTo(u.id, { t: 'gameOver', result: won ? 'win' : 'loss', reward: { gold, bonus: 0, first }, opponent: bot.name, reason: g.endReason, bot: bot.id, botKind: bot.kind });
  for (const id of spectators.get(g.id) || []) sendTo(id, { t: 'spectateEnd', winner: g.players[g.winner].name, loser: g.players[1 - g.winner].name, reason: g.endReason });
  spectators.delete(g.id);
  setTimeout(() => games.delete(g.id), 10 * 60_000);
  sendMe(u); broadcastLobby();
}

function startGame(aId, aDeck, bId, bDeck, isDraft) {
  const a = userById(aId), b = userById(bId);
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const g = new Game(id, [
    { userId: a.id, name: a.username, avatar: a.avatar, deck: aDeck.cards },
    { userId: b.id, name: b.username, avatar: b.avatar, deck: bDeck.cards },
  ]);
  g.isDraft = isDraft;
  g.turnLimitMs = TURN_LIMIT_MS;
  g.start();
  g.mulliganEndsAt = Date.now() + 40_000;
  setTimeout(() => { if (g.phase === 'mulligan' && !g.over) { g.autoMulligan(); sendGame(g); } }, 40_500);
  games.set(id, g);
  userGame.set(a.id, id); userGame.set(b.id, id);
  stopSpectating(a.id); stopSpectating(b.id);
  for (const k of [...challenges.keys()]) {
    const c = challenges.get(k);
    if ([a.id, b.id].includes(k) || [a.id, b.id].includes(c.to)) challenges.delete(k);
  }
  sendGame(g); broadcastLobby();
}

function settleGame(g) {
  if (!g.over || g.settled) return;
  g.settled = true;
  clearTimeout(g.turnTimer);
  if (g.bot) return settleBotGame(g);
  const w = userById(g.players[g.winner].userId);
  const l = userById(g.players[1 - g.winner].userId);
  
  if (g.isDraft) {
      w.draftStreak = (w.draftStreak || 0) + 1;
      
      const existing = db.draftLeaderboard.find(x => x.id === w.id);
      if (existing) {
          if (w.draftStreak > existing.draftStreak) existing.draftStreak = w.draftStreak;
      } else {
          db.draftLeaderboard.push({ id: w.id, username: w.username, draftStreak: w.draftStreak });
      }
      db.draftLeaderboard.sort((a,b) => b.draftStreak - a.draftStreak);
      
      l.draft = null;
      l.draftStreak = 0;
      sendTo(l.id, { t: 'draftState', draft: null });
      sendTo(w.id, { t: 'draftState', draft: w.draft });
  }
  
  w.stats.wins++; l.stats.losses++;
  w.gold += WIN_GOLD;
  let bonus = 0;
  if (!w.defeated.includes(l.id)) w.defeated.push(l.id);
  if (w.defeated.length >= BONUS_DISTINCT) {
    bonus = BONUS_GOLD; w.gold += BONUS_GOLD; w.stats.bonuses++; w.defeated = [];
  }
  db.history.push({ at: Date.now(), winner: w.username, loser: l.username, reason: g.endReason, bonus: bonus > 0, isDraft: g.isDraft });
  if (db.history.length > 200) db.history.shift();
  scheduleSave();
  
  const reward = { gold: WIN_GOLD, bonus };
  sendTo(w.id, { t: 'gameOver', result: 'win', reward, opponent: l.username, reason: g.endReason });
  sendTo(l.id, { t: 'gameOver', result: 'loss', reward: { gold: 0, bonus: 0 }, opponent: w.username, reason: g.endReason });
  userGame.delete(w.id); userGame.delete(l.id);
  for (const id of spectators.get(g.id) || []) sendTo(id, { t: 'spectateEnd', winner: w.username, loser: l.username, reason: g.endReason });
  spectators.delete(g.id);
  setTimeout(() => games.delete(g.id), 10 * 60_000);
  sendMe(w); sendMe(l); broadcastLobby();
}

function handle(ws, msg) {
  const t = msg.t;
  if (t === 'register') {
    const name = String(msg.username || '').trim();
    const pw = String(msg.password || '');
    if (!/^[\p{L}\p{N}_.-]{3,16}$/u.test(name)) return send(ws, { t: 'registerError', msg: 'Nazwa: 3–16 znaków (litery, cyfry, _ . -), bez spacji.' });
    if (userByName(name)) return send(ws, { t: 'registerError', msg: 'Nazwa zajęta.' });
    if (pw.length < 4) return send(ws, { t: 'registerError', msg: 'Hasło musi mieć co najmniej 4 znaki.' });
    if (db.users.length >= MAX_ACCOUNTS) return send(ws, { t: 'registerError', msg: 'Limit kont.' });
    const avatar = validAvatar(msg.avatar);
    if (!avatar) return send(ws, { t: 'registerError', msg: 'Wybierz zdjęcie profilowe.' });
    db.users.push(newUser(name, avatar, pw));
    scheduleSave();
    msg = { t: 'login', username: name, password: pw };
  }
  if (msg.t === 'login' || msg.t === 'resume') {
    let u = null;
    if (msg.t === 'login') {
      u = userByName(msg.username);
      if (!u || !checkPassword(u, String(msg.password || ''))) return send(ws, { t: 'loginError', msg: 'Zły login lub hasło.' });
    } else {
      u = db.users.find(x => x.sessions.includes(msg.token));
      if (!u) return send(ws, { t: 'loginError', msg: '', silent: true });
    }
    let token = msg.token;
    if (msg.t === 'login') {
      token = crypto.randomBytes(24).toString('hex');
      u.sessions = [token, ...u.sessions].slice(0, 8);
      scheduleSave();
    }
    const old = sockets.get(u.id);
    if (old && old !== ws) { send(old, { t: 'kicked', msg: 'Zalogowano na tym koncie w innym oknie.' }); old.userId = null; old.close(); }
    ws.userId = u.id;
    sockets.set(u.id, ws);
    offlineSince.delete(u.id);
    send(ws, { t: 'auth', token, me: publicProfile(u), cards: PUBLIC_CARDS, bots: publicBots() });
    send(ws, { t: 'market', ...marketState() });
    if (u.draft) send(ws, { t: 'draftState', draft: u.draft });
    const gid = userGame.get(u.id);
    if (gid && games.get(gid)) {
      const g = games.get(gid);
      send(ws, { t: 'game', view: g.view(g.players.findIndex(p => p.userId === u.id)) });
      const other = g.players.find(p => p.userId !== u.id);
      if (!other.isBot) sendTo(other.userId, { t: 'opponentBack', msg: `${u.username} wrócił do gry.` });
    }
    broadcastLobby();
    return;
  }

  const u = ws.userId && userById(ws.userId);
  if (!u) return send(ws, { t: 'loginError', msg: 'Zaloguj się ponownie.' });
  const err = m => send(ws, { t: 'error', msg: m });

  switch (t) {
    case 'logout': u.sessions = u.sessions.filter(s => s !== msg.token); scheduleSave(); sockets.delete(u.id); ws.userId = null; broadcastLobby(); return;
    case 'changePassword': {
      if (!checkPassword(u, String(msg.oldPassword || ''))) return err('Stare hasło jest niepoprawne.');
      const np = String(msg.newPassword || '');
      if (np.length < 4) return err('Hasło musi mieć co najmniej 4 znaki.');
      Object.assign(u, hashPassword(np));
      u.sessions = msg.token ? [msg.token] : []; scheduleSave(); return send(ws, { t: 'toast', msg: 'Hasło zmienione.' });
    }
    case 'setAvatar': u.avatar = validAvatar(msg.avatar) || u.avatar; scheduleSave(); sendMe(u); broadcastLobby(); return;
    case 'buyPack': {
      const p = PACKS[msg.kind];
      if (!p || u.gold < p.price) return err('Za mało złota.');
      u.gold -= p.price; u.packs[msg.kind]++; scheduleSave(); sendMe(u); return;
    }
    case 'openPack': {
      if (!PACKS[msg.kind] || u.packs[msg.kind] <= 0) return err('Nie masz takiej paczki.');
      u.packs[msg.kind]--;
      const drawn = [];
      for (let i = 0; i < 5; i++) drawn.push(i === 0 && msg.kind === 'leg' ? randomByRarity(3) : rollCard());
      for (const c of drawn) u.collection[c.name] = (u.collection[c.name] || 0) + 1;
      scheduleSave(); send(ws, { t: 'packOpened', kind: msg.kind, cards: drawn.map(c => c.name) }); sendMe(u); return;
    }
    case 'saveDeck': {
      const name = String(msg.name || '').trim().slice(0, 30) || 'Talia', cards = (msg.cards || []).map(String);
      const e = validateDeck(u, cards); if (e) return err(e);
      let d = msg.id && u.decks.find(x => x.id === msg.id);
      if (!d) { d = { id: 'd' + crypto.randomBytes(4).toString('hex') }; u.decks.push(d); }
      d.name = name; d.cards = cards; scheduleSave(); sendMe(u); return send(ws, { t: 'deckSaved', id: d.id });
    }
    case 'disenchant': {
      // msg.cards: { nazwa: ilość } – rozbija podane kopie (tylko wolne, nie wystawione na rynku)
      const req = msg.cards && typeof msg.cards === 'object' ? msg.cards : { [msg.name]: msg.count || 1 };
      let gained = 0, n = 0;
      for (const [name, rawK] of Object.entries(req)) {
        const c = BY_NAME[name]; const k = Math.floor(Number(rawK));
        if (!c || !(k > 0)) return err('Zła karta do rozbicia.');
        const free = (u.collection[name] || 0) - offeredCount(u, name);
        if (k > free) return err(free > 0 ? `Możesz rozbić najwyżej ${free}× ${name}.` : `Nie masz wolnej kopii: ${name}${offeredCount(u, name) ? ' (jest wystawiona na rynku)' : ''}.`);
      }
      for (const [name, rawK] of Object.entries(req)) {
        const k = Math.floor(Number(rawK));
        u.collection[name] -= k; gained += DUST.disenchant[BY_NAME[name].rarity] * k; n += k;
      }
      u.dust += gained;
      afterCollectionLoss(u);
      scheduleSave(); sendMe(u); broadcastMarket();
      return send(ws, { t: 'crafted', kind: 'disenchant', dust: gained, count: n });
    }
    case 'craft': {
      const c = BY_NAME[msg.name];
      if (!c || c.token || c.hidden) return err('Nieznana karta.');
      const cost = DUST.craft[c.rarity];
      if (u.dust < cost) return err(`Za mało pyłu – potrzeba ${cost}, masz ${u.dust}.`);
      u.dust -= cost;
      u.collection[c.name] = (u.collection[c.name] || 0) + 1;
      scheduleSave(); sendMe(u);
      return send(ws, { t: 'crafted', kind: 'craft', name: c.name, dust: cost });
    }
    case 'marketPost': {
      const give = BY_NAME[msg.give], want = BY_NAME[msg.want];
      if (!give || !want || give.token || want.token) return err('Nieznana karta.');
      if (give.name === want.name) return err('Wybierz inną kartę do otrzymania.');
      if (give.rarity !== want.rarity) return err('Wymieniać można tylko karty tej samej rzadkości.');
      if ((u.collection[give.name] || 0) <= offeredCount(u, give.name)) return err(`Nie masz wolnej kopii: ${give.name}.`);
      if (userOffers(u).length >= MAX_OFFERS_PER_USER) return err(`Możesz mieć najwyżej ${MAX_OFFERS_PER_USER} ofert naraz.`);
      // jeśli ktoś już oferuje dokładnie odwrotną wymianę – wymieniamy od razu
      const match = db.market.find(o => o.userId !== u.id && o.give === want.name && o.want === give.name);
      if (match) { executeTrade(match, u); return; }
      db.market.push({ id: 'o' + crypto.randomBytes(4).toString('hex'), userId: u.id, give: give.name, want: want.name, at: Date.now() });
      scheduleSave(); broadcastMarket();
      return send(ws, { t: 'toast', msg: 'Oferta wystawiona na rynek.' });
    }
    case 'marketCancel': {
      const before = db.market.length;
      db.market = db.market.filter(o => !(o.id === msg.id && o.userId === u.id));
      if (db.market.length !== before) { scheduleSave(); broadcastMarket(); }
      return;
    }
    case 'marketAccept': {
      const o = db.market.find(x => x.id === msg.id);
      if (!o) return err('Ta oferta już nie istnieje.');
      if (o.userId === u.id) return err('To Twoja oferta.');
      if (!(u.collection[o.want] > 0)) return err(`Nie masz karty ${o.want}.`);
      const maker = userById(o.userId);
      if (!maker || !(maker.collection[o.give] > 0)) { db.market = db.market.filter(x => x !== o); broadcastMarket(); return err('Wystawiający nie ma już tej karty.'); }
      executeTrade(o, u);
      return;
    }
    case 'deleteDeck': u.decks = u.decks.filter(d => d.id !== msg.id); scheduleSave(); sendMe(u); return;
    case 'challenge': {
      const to = userById(msg.to);
      if (!to || to.id === u.id) return err('Nie można wyzwać tego gracza.');
      if (!sockets.has(to.id)) return err(`${to.username} jest offline.`);
      if (userGame.has(to.id)) return err(`${to.username} jest w trakcie gry.`);
      if (userGame.has(u.id)) return err('Jesteś w trakcie gry.');
      if (msg.isDraft) {
          if (!u.draft || !u.draft.ready) return err('Nie masz gotowej talii draftu.');
          if (!to.draft || !to.draft.ready) return err(`${to.username} nie ma gotowej talii draftu.`);
          challenges.set(u.id, { to: to.id, isDraft: true, at: Date.now() });
      } else {
          const deck = u.decks.find(d => d.id === msg.deckId);
          if (!deck) return err('Wybierz talię.');
          const e = validateDeck(u, deck.cards); if (e) return err('Twoja talia jest niepoprawna: ' + e);
          challenges.set(u.id, { to: to.id, deckId: deck.id, isDraft: false, at: Date.now() });
      }
      sendTo(to.id, { t: 'challenged', from: u.id, fromName: u.username, isDraft: msg.isDraft }); broadcastLobby(); return;
    }
    case 'startBot': {
      const bot = BOTS[msg.bot];
      if (!bot) return err('Nie ma takiego przeciwnika.');
      if (userGame.has(u.id)) return err('Jesteś już w grze.');
      const deck = u.decks.find(d => d.id === msg.deckId);
      if (!deck) return err('Wybierz talię.');
      const e = validateDeck(u, deck.cards); if (e) return err('Twoja talia jest niepoprawna: ' + e);
      startBotGame(u, deck, bot); return;
    }
    case 'cancelChallenge': challenges.delete(u.id); broadcastLobby(); return;
    case 'declineChallenge': challenges.delete(msg.from); broadcastLobby(); return;
    case 'acceptChallenge': {
      const c = challenges.get(msg.from);
      if (!c || c.to !== u.id) return err('Wyzwanie nie istnieje.');
      const from = userById(msg.from);
      if (!sockets.has(from.id) || userGame.has(from.id) || userGame.has(u.id)) { challenges.delete(msg.from); broadcastLobby(); return err('Ktoś jest już w grze.'); }
      
      if (c.isDraft) {
          if (!u.draft || !u.draft.ready) return err('Nie masz talii draftu.');
          startGame(from.id, { cards: from.draft.deck }, u.id, { cards: u.draft.deck }, true);
      } else {
          const myDeck = u.decks.find(d => d.id === msg.deckId);
          if (!myDeck || validateDeck(u, myDeck.cards)) return err('Twoja talia jest niepoprawna.');
          const theirDeck = from.decks.find(d => d.id === c.deckId);
          if (!theirDeck || validateDeck(from, theirDeck.cards)) { challenges.delete(msg.from); broadcastLobby(); return err('Talia przeciwnika jest już niepoprawna.'); }
          startGame(from.id, theirDeck, u.id, myDeck, false);
      }
      return;
    }
    case 'act': {
      const g = games.get(userGame.get(u.id));
      if (!g) return err('Nie jesteś w grze.');
      const i = g.players.findIndex(p => p.userId === u.id);
      try { g.action(i, msg.action || {}); } catch (e) { if (e instanceof GameError) return err(e.message); throw e; }
      sendGame(g); if (g.over) settleGame(g); return;
    }
    case 'claimWin': {
      const g = games.get(userGame.get(u.id));
      if (!g || g.over) return;
      if (g.bot) return err('To gra z komputerem.');
      const i = g.players.findIndex(p => p.userId === u.id), other = g.players[1 - i].userId, since = offlineSince.get(other);
      if (sockets.has(other) || !since || Date.now() - since < FORFEIT_AFTER_MS) return err('Przeciwnik może wrócić.');
      g.say(`${g.players[1 - i].name} opuścił grę – walkower.`); g.finish(i, 'forfeit');
      sendGame(g); settleGame(g); return;
    }
    
    // ---------- draft actions ----------
    case 'draftStart': {
        if (DRAFT_COST > 0 && u.gold < DRAFT_COST) return err('Za mało złota.');
        u.gold -= DRAFT_COST;
        u.draft = { ready: false, round: 1, deck: [], choices: generateDraftChoices(1) };
        scheduleSave(); sendMe(u); send(ws, { t: 'draftState', draft: u.draft }); broadcastLobby(); return;
    }
    case 'draftPick': {
        if (!u.draft || u.draft.ready || !u.draft.choices.includes(msg.pick)) return err('Zły wybór.');
        const round = u.draft.round;
        let count = 1;
        if (round >= 4 && round <= 6) count = 3;
        else if (round >= 7 && round <= 10) count = 2;
        
        for (let idx = 0; idx < count; idx++) u.draft.deck.push(msg.pick);
        u.draft.round++;
        
        if (u.draft.round > 10) {
            u.draft.ready = true; u.draft.choices = []; u.draftStreak = 0;
        } else {
            u.draft.choices = generateDraftChoices(u.draft.round);
        }
        scheduleSave(); send(ws, { t: 'draftState', draft: u.draft }); broadcastLobby(); return;
    }
    case 'draftRetire': {
        u.draft = null; u.draftStreak = 0;
        scheduleSave(); sendMe(u); send(ws, { t: 'draftState', draft: null }); broadcastLobby(); return;
    }
    case 'draftUpdate': {
        if (u.draft) send(ws, { t: 'draftState', draft: u.draft }); return;
    }

    // ---------- admin ----------
    case 'adminList': case 'adminSetDust': case 'adminSetGold': case 'adminAddGold': case 'adminSetPacks': case 'adminResetPassword': {
      if (!isAdmin(u)) return err('Brak uprawnień administratora.');
      if (t !== 'adminList') {
        const target = userById(msg.id); if (!target) return err('Nie ma gracza.');
        const num = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : null; };
        if (t === 'adminSetGold') target.gold = Math.max(0, Math.min(num(msg.gold) || 0, 1e9));
        else if (t === 'adminAddGold') target.gold = Math.max(0, target.gold + (num(msg.amount) || 0));
        else if (t === 'adminSetDust') target.dust = Math.max(0, Math.min(num(msg.dust) || 0, 1e9));
        else if (t === 'adminSetPacks') target.packs = { std: Math.max(0, num(msg.std) || 0), leg: Math.max(0, num(msg.leg) || 0) };
        else if (t === 'adminResetPassword') { Object.assign(target, hashPassword(DEFAULT_PASSWORD)); target.sessions = []; }
        scheduleSave(); sendMe(target); broadcastLobby();
        sendTo(target.id, { t: 'toast', msg: 'Administrator zmienił Twoje konto.' });
        send(ws, { t: 'toast', msg: `Zapisano: ${target.username}` });
      }
      return send(ws, { t: 'adminUsers', users: db.users.map(x => ({ id: x.id, username: x.username, avatar: x.avatar, gold: x.gold, dust: x.dust, packs: x.packs, stats: x.stats, online: sockets.has(x.id) })) });
    }
    case 'cashOut': {
      const n = u.defeated.length, gold = CASH_OUT[n];
      if (!gold) return err('Wypłata jest możliwa przy 3/5 albo 4/5 pokonanych graczy.');
      u.gold += gold; u.defeated = []; scheduleSave(); sendMe(u); broadcastLobby();
      return send(ws, { t: 'toast', msg: `Wypłacono ${gold} złota.` });
    }
    case 'spectate': {
      const target = userById(msg.userId), gid = target && userGame.get(target.id), g = gid && games.get(gid);
      if (!g || g.over) return err('Gracz nie jest w grze.');
      if (userGame.has(u.id)) return err('Nie możesz oglądać, gdy sam grasz.');
      stopSpectating(u.id);
      if (!spectators.has(g.id)) spectators.set(g.id, new Set());
      spectators.get(g.id).add(u.id); send(ws, { t: 'game', view: g.spectatorView() });
      for (const p of g.players) sendTo(p.userId, { t: 'toast', msg: `${u.username} ogląda grę 👀` });
      broadcastLobby(); return;
    }
    case 'stopSpectate': stopSpectating(u.id); broadcastLobby(); return;
    case 'ping': return send(ws, { t: 'pong' });
    default: return err('Nieznana wiadomość.');
  }
}

async function main() {
  await loadDb();
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, file) {
      if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }));
  app.get('/health', (_req, res) => res.send('ok'));
  app.get('/api/cards', (_req, res) => res.json(PUBLIC_CARDS.filter(c => !c.hidden).map(c => ({ name: c.name, art: c.art }))));
  app.get('/api/users', (_req, res) => res.json(db.users.map(u => ({ username: u.username, avatar: u.avatar }))));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', ws => {
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => { let msg; try { msg = JSON.parse(raw); } catch { return; } try { handle(ws, msg); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Błąd serwera.' }); } });
    ws.on('close', () => {
      if (ws.userId && sockets.get(ws.userId) === ws) {
        const id = ws.userId; sockets.delete(id); challenges.delete(id); stopSpectating(id); offlineSince.set(id, Date.now());
        const gid = userGame.get(id), g = gid && games.get(gid);
        if (g && !g.over && !g.bot) sendTo(g.players.find(p => p.userId !== id).userId, { t: 'opponentLeft', at: Date.now(), waitMs: FORFEIT_AFTER_MS });
        broadcastLobby();
      }
    });
  });

  setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25_000);
  server.listen(PORT, () => console.log(`DCG działa na http://localhost:${PORT}`));

  const selfUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && process.env.KEEPALIVE !== 'off') setInterval(() => fetch(selfUrl.replace(/\/$/, '') + '/health').catch(() => {}), 10 * 60_000).unref();

  let closing = false;
  const shutdown = async sig => {
    if (closing) return; closing = true;
    clearTimeout(saveTimer); try { await store.save(db); } catch (e) {} process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };