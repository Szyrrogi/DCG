// Serwer gry: konta, złoto, paczki, kolekcja, talie, lobby i walki 1v1 przez WebSocket.
'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game, GameError, CARDS, BY_NAME } = require('./engine');
const { createStore } = require('./store');
// karty wysyłane do klientów – bez ukrytych zdolności (np. znikanie Gustava)
const PUBLIC_CARDS = CARDS.map(c => c.hiddenDeath ? { ...c, turnsUntilDeath: -1, hiddenDeath: undefined } : c);

const PORT = process.env.PORT || 3000;
const WIN_GOLD = 10;
const BONUS_GOLD = 100;
const BONUS_DISTINCT = 5;
const DECK_SIZE = 20;
const PACKS = { std: { price: 50, label: 'Zwykła paczka' }, leg: { price: 500, label: 'Legendarna paczka' } };
const START = { gold: 1000, std: 5, leg: 1 }; // jak SaveData w wersji Unity
// Konta startowe: [nazwa, domyślny awatar, dawne nazwy do migracji]
const ACCOUNTS = [
  ['szyrrogi', 'f3', ['igor']],
  ['juli', 'f1', []],
  ['tofame', 'f5', []],
  ['olaf', 'f4', []],
  ['jędrek', 'f2', []],
  ['massyn', 'f6', []],
];
// Administratorzy (mogą zmieniać złoto itp.) – można nadpisać zmienną ADMINS="szyrrogi,juli"
const ADMINS = (process.env.ADMINS || 'szyrrogi').split(',').map(s => norm(s)).filter(Boolean);
const MAX_ACCOUNTS = 60;
const FACES = 9;
const MAX_OFFERS_PER_USER = 10;
// wcześniejsza wypłata bonusu: przy 3/5 pokonanych 30 złota, przy 4/5 – 60 złota (potem seria od nowa)
const CASH_OUT = { 3: 30, 4: 60 };
// Wytwarzanie (jak w Hearthstone): rozbijanie kart na pył i tworzenie wybranych kart z pyłu
const DUST = {
  disenchant: { 1: 5, 2: 20, 3: 100 },   // ile pyłu daje rozbicie
  craft: { 1: 40, 2: 100, 3: 400 },      // ile kosztuje wytworzenie
};
const DEFAULT_PASSWORD = 'haslo';
const FORFEIT_AFTER_MS = 60_000;

// ---------------- dane ----------------
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

// porównywanie nazw bez wielkości liter i polskich znaków (jędrek == Jedrek)
function norm(n) {
  return String(n || '').trim().toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
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
    collection: {}, decks: [], defeated: [],
    stats: { wins: 0, losses: 0, bonuses: 0 }, sessions: [],
  };
}

async function loadDb() {
  db = (await store.load()) || { users: [], history: [] };
  db.users = db.users || [];
  db.history = db.history || [];
  db.market = db.market || [];   // otwarte oferty wymiany
  db.trades = db.trades || [];   // historia wymian
  for (const u of db.users) { u.avatar = validAvatar(u.avatar) || 'f1'; if (typeof u.dust !== 'number') u.dust = 0; } // starsze zapisy
  for (const [name, avatar, old] of ACCOUNTS) {
    const keys = [norm(name), ...old.map(norm)];
    const existing = db.users.find(u => keys.includes(norm(u.username)));
    if (existing) existing.username = name;          // migracja np. Igor -> szyrrogi
    else db.users.push(newUser(name, avatar));
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
    rules: { winGold: WIN_GOLD, bonusGold: BONUS_GOLD, bonusDistinct: BONUS_DISTINCT, deckSize: DECK_SIZE, packs: PACKS, dust: DUST, cashOut: CASH_OUT },
  };
}

// ---------------- paczki (PackSystem.cs) ----------------
function randomByRarity(r) {
  const pool = CARDS.filter(c => c.rarity === r);
  return pool[Math.floor(Math.random() * pool.length)];
}
function rollCard() {
  const roll = Math.random() * 100;
  if (roll <= 1) return randomByRarity(3);
  if (roll <= 11) return randomByRarity(2);
  return randomByRarity(1);
}

// ---------------- talie ----------------
// ---------------- rynek wymiany ----------------
// Gdy karta znika z kolekcji, nadmiarowe kopie wypadają z talii – zostaje puste miejsce do uzupełnienia.
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
// oferta nie może oddawać więcej kopii, niż gracz ma – nadmiarowe są wycofywane
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
    sendTo(u.id, { t: 'toast', msg: `Karta odeszła z kolekcji – puste miejsce w talii ${txt}. Uzupełnij talię w Kolekcji.` });
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
  sendMe(maker); sendMe(taker);
  broadcastMarket();
}

function validateDeck(u, cards) {
  if (!Array.isArray(cards)) return 'Zła talia.';
  if (cards.length !== DECK_SIZE) return `Talia musi mieć dokładnie ${DECK_SIZE} kart (ma ${cards.length}).`;
  const counts = {};
  for (const n of cards) {
    if (!BY_NAME[n]) return `Nieznana karta: ${n}`;
    counts[n] = (counts[n] || 0) + 1;
  }
  for (const [n, k] of Object.entries(counts)) {
    const max = BY_NAME[n].rarity === 1 ? 3 : 1;
    if (k > max) return `${n}: maksymalnie ${max} ${max === 1 ? 'kopia' : 'kopie'} w talii.`;
    if (k > (u.collection[n] || 0)) return `Masz tylko ${u.collection[n] || 0}× ${n}.`;
  }
  return null;
}

// ---------------- połączenia ----------------
const sockets = new Map();    // userId -> ws
const games = new Map();      // gameId -> Game
const userGame = new Map();   // userId -> gameId
const challenges = new Map(); // fromId -> { to, deckId, at }
const offlineSince = new Map();
const spectators = new Map(); // gameId -> Set(userId) obserwatorów

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendTo(userId, msg) { send(sockets.get(userId), msg); }
function sendMe(u) { sendTo(u.id, { t: 'me', me: publicProfile(u) }); }

function lobbyState() {
  return db.users.map(u => ({
    id: u.id, username: u.username, avatar: u.avatar, online: sockets.has(u.id),
    inGame: userGame.has(u.id), stats: u.stats, gold: u.gold, defeatedCount: u.defeated.length,
    watchers: userGame.has(u.id) ? (spectators.get(userGame.get(u.id)) || new Set()).size : 0,
    opponent: userGame.has(u.id) ? (games.get(userGame.get(u.id)) || { players: [] }).players.map(p => p.name).find(n => n !== u.username) || null : null,
  }));
}
function broadcastLobby() {
  const players = lobbyState();
  const ch = [...challenges.entries()].map(([from, c]) => ({ from, to: c.to }));
  for (const [id, ws] of sockets) send(ws, { t: 'lobby', players, challenges: ch.filter(c => c.from === id || c.to === id), history: db.history.slice(-15).reverse() });
}

function spectatorOf(userId) {
  for (const [gid, set] of spectators) if (set.has(userId)) return gid;
  return null;
}
function stopSpectating(userId) {
  for (const [gid, set] of spectators) { set.delete(userId); if (!set.size) spectators.delete(gid); }
}
function sendGame(g) {
  g.players.forEach((p, i) => sendTo(p.userId, { t: 'game', view: g.view(i) }));
  const set = spectators.get(g.id);
  if (set && set.size) { const sv = g.spectatorView(); for (const id of set) sendTo(id, { t: 'game', view: sv }); }
}

function startGame(aId, aDeck, bId, bDeck) {
  const a = userById(aId), b = userById(bId);
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const g = new Game(id, [
    { userId: a.id, name: a.username, avatar: a.avatar, deck: aDeck.cards },
    { userId: b.id, name: b.username, avatar: b.avatar, deck: bDeck.cards },
  ]);
  g.start();
  // wymiana kart startowych: kto nie zdecyduje w 40 s, zostaje z obecną ręką
  g.mulliganEndsAt = Date.now() + 40_000;
  setTimeout(() => { if (g.phase === 'mulligan' && !g.over) { g.autoMulligan(); sendGame(g); } }, 40_500);
  games.set(id, g);
  userGame.set(a.id, id); userGame.set(b.id, id);
  stopSpectating(a.id); stopSpectating(b.id);
  for (const k of [...challenges.keys()]) {
    const c = challenges.get(k);
    if ([a.id, b.id].includes(k) || [a.id, b.id].includes(c.to)) challenges.delete(k);
  }
  sendGame(g);
  broadcastLobby();
}

function settleGame(g) {
  if (!g.over || g.settled) return;
  g.settled = true;
  const w = userById(g.players[g.winner].userId);
  const l = userById(g.players[1 - g.winner].userId);
  w.stats.wins++; l.stats.losses++;
  w.gold += WIN_GOLD;
  let bonus = 0;
  if (!w.defeated.includes(l.id)) w.defeated.push(l.id);
  if (w.defeated.length >= BONUS_DISTINCT) {
    bonus = BONUS_GOLD; w.gold += BONUS_GOLD; w.stats.bonuses++; w.defeated = [];
  }
  db.history.push({ at: Date.now(), winner: w.username, loser: l.username, reason: g.endReason, bonus: bonus > 0 });
  if (db.history.length > 200) db.history.shift();
  scheduleSave();
  const reward = { gold: WIN_GOLD, bonus };
  sendTo(w.id, { t: 'gameOver', result: 'win', reward, opponent: l.username, reason: g.endReason });
  sendTo(l.id, { t: 'gameOver', result: 'loss', reward: { gold: 0, bonus: 0 }, opponent: w.username, reason: g.endReason });
  userGame.delete(w.id); userGame.delete(l.id);
  for (const id of spectators.get(g.id) || []) sendTo(id, { t: 'spectateEnd', winner: w.username, loser: l.username, reason: g.endReason });
  spectators.delete(g.id);
  setTimeout(() => games.delete(g.id), 10 * 60_000);
  sendMe(w); sendMe(l);
  broadcastLobby();
}

// ---------------- obsługa wiadomości ----------------
function handle(ws, msg) {
  const t = msg.t;
  if (t === 'register') {
    const name = String(msg.username || '').trim();
    const pw = String(msg.password || '');
    if (!/^[\p{L}\p{N}_.-]{3,16}$/u.test(name)) return send(ws, { t: 'registerError', msg: 'Nazwa: 3–16 znaków (litery, cyfry, _ . -), bez spacji.' });
    if (userByName(name)) return send(ws, { t: 'registerError', msg: 'Taka nazwa jest już zajęta.' });
    if (pw.length < 4) return send(ws, { t: 'registerError', msg: 'Hasło musi mieć co najmniej 4 znaki.' });
    if (db.users.length >= MAX_ACCOUNTS) return send(ws, { t: 'registerError', msg: 'Osiągnięto limit kont na serwerze.' });
    const avatar = validAvatar(msg.avatar);
    if (!avatar) return send(ws, { t: 'registerError', msg: 'Wybierz zdjęcie profilowe.' });
    db.users.push(newUser(name, avatar, pw));
    scheduleSave();
    console.log(`Nowe konto: ${name}`);
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
    send(ws, { t: 'auth', token, me: publicProfile(u), cards: PUBLIC_CARDS });
    send(ws, { t: 'market', ...marketState() });
    const gid = userGame.get(u.id);
    if (gid && games.get(gid)) {
      const g = games.get(gid);
      send(ws, { t: 'game', view: g.view(g.players.findIndex(p => p.userId === u.id)) });
      const other = g.players.find(p => p.userId !== u.id);
      sendTo(other.userId, { t: 'opponentBack', msg: `${u.username} wrócił do gry.` });
    }
    broadcastLobby();
    return;
  }

  const u = ws.userId && userById(ws.userId);
  if (!u) return send(ws, { t: 'loginError', msg: 'Zaloguj się ponownie.' });
  const err = m => send(ws, { t: 'error', msg: m });

  switch (t) {
    case 'logout': {
      u.sessions = u.sessions.filter(s => s !== msg.token);
      scheduleSave();
      sockets.delete(u.id); ws.userId = null;
      broadcastLobby();
      return;
    }
    case 'changePassword': {
      if (!checkPassword(u, String(msg.oldPassword || ''))) return err('Stare hasło jest niepoprawne.');
      const np = String(msg.newPassword || '');
      if (np.length < 4) return err('Nowe hasło musi mieć co najmniej 4 znaki.');
      Object.assign(u, hashPassword(np));
      u.sessions = msg.token ? [msg.token] : [];
      scheduleSave();
      return send(ws, { t: 'toast', msg: 'Hasło zmienione.' });
    }
    case 'setAvatar': {
      const a = validAvatar(msg.avatar);
      if (!a) return err('Zły awatar.');
      u.avatar = a; scheduleSave(); sendMe(u); broadcastLobby();
      return;
    }
    case 'buyPack': {
      const p = PACKS[msg.kind];
      if (!p) return err('Nieznana paczka.');
      if (u.gold < p.price) return err('Za mało złota.');
      u.gold -= p.price; u.packs[msg.kind]++;
      scheduleSave(); sendMe(u);
      return;
    }
    case 'openPack': {
      if (!PACKS[msg.kind]) return err('Nieznana paczka.');
      if (u.packs[msg.kind] <= 0) return err('Nie masz takiej paczki.');
      u.packs[msg.kind]--;
      const drawn = [];
      for (let i = 0; i < 5; i++) drawn.push(i === 0 && msg.kind === 'leg' ? randomByRarity(3) : rollCard());
      for (const c of drawn) u.collection[c.name] = (u.collection[c.name] || 0) + 1;
      scheduleSave();
      send(ws, { t: 'packOpened', kind: msg.kind, cards: drawn.map(c => c.name) });
      sendMe(u);
      return;
    }
    case 'saveDeck': {
      const name = String(msg.name || '').trim().slice(0, 30) || 'Talia';
      const cards = (msg.cards || []).map(String);
      const e = validateDeck(u, cards);
      if (e) return err(e);
      let d = msg.id && u.decks.find(x => x.id === msg.id);
      if (!d) { d = { id: 'd' + crypto.randomBytes(4).toString('hex') }; u.decks.push(d); }
      d.name = name; d.cards = cards;
      scheduleSave(); sendMe(u);
      return send(ws, { t: 'deckSaved', id: d.id });
    }
    // ---------- wytwarzanie ----------
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
      if (!c) return err('Nieznana karta.');
      const cost = DUST.craft[c.rarity];
      if (u.dust < cost) return err(`Za mało pyłu – potrzeba ${cost}, masz ${u.dust}.`);
      u.dust -= cost;
      u.collection[c.name] = (u.collection[c.name] || 0) + 1;
      scheduleSave(); sendMe(u);
      return send(ws, { t: 'crafted', kind: 'craft', name: c.name, dust: cost });
    }
    case 'marketPost': {
      const give = BY_NAME[msg.give], want = BY_NAME[msg.want];
      if (!give || !want) return err('Nieznana karta.');
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
    case 'deleteDeck': {
      u.decks = u.decks.filter(d => d.id !== msg.id);
      scheduleSave(); sendMe(u);
      return;
    }
    case 'challenge': {
      const to = userById(msg.to);
      if (!to || to.id === u.id) return err('Nie można wyzwać tego gracza.');
      if (!sockets.has(to.id)) return err(`${to.username} jest offline.`);
      if (userGame.has(to.id)) return err(`${to.username} jest w trakcie gry.`);
      if (userGame.has(u.id)) return err('Jesteś w trakcie gry.');
      const deck = u.decks.find(d => d.id === msg.deckId);
      if (!deck) return err('Wybierz talię.');
      const e = validateDeck(u, deck.cards); if (e) return err('Twoja talia jest niepoprawna: ' + e);
      challenges.set(u.id, { to: to.id, deckId: deck.id, at: Date.now() });
      sendTo(to.id, { t: 'challenged', from: u.id, fromName: u.username });
      broadcastLobby();
      return;
    }
    case 'cancelChallenge': challenges.delete(u.id); broadcastLobby(); return;
    case 'declineChallenge': {
      const c = challenges.get(msg.from);
      if (c && c.to === u.id) { challenges.delete(msg.from); sendTo(msg.from, { t: 'toast', msg: `${u.username} odrzucił wyzwanie.` }); }
      broadcastLobby();
      return;
    }
    case 'acceptChallenge': {
      const c = challenges.get(msg.from);
      if (!c || c.to !== u.id) return err('To wyzwanie już nie istnieje.');
      const from = userById(msg.from);
      if (!sockets.has(from.id)) { challenges.delete(msg.from); broadcastLobby(); return err(`${from.username} wyszedł.`); }
      if (userGame.has(from.id) || userGame.has(u.id)) return err('Ktoś jest już w grze.');
      const myDeck = u.decks.find(d => d.id === msg.deckId);
      if (!myDeck) return err('Wybierz talię.');
      const e = validateDeck(u, myDeck.cards); if (e) return err('Twoja talia jest niepoprawna: ' + e);
      const theirDeck = from.decks.find(d => d.id === c.deckId);
      if (!theirDeck || validateDeck(from, theirDeck.cards)) { challenges.delete(msg.from); broadcastLobby(); return err('Talia przeciwnika jest już niepoprawna.'); }
      startGame(from.id, theirDeck, u.id, myDeck);
      return;
    }
    case 'act': {
      const g = games.get(userGame.get(u.id));
      if (!g) return err('Nie jesteś w grze.');
      const i = g.players.findIndex(p => p.userId === u.id);
      try { g.action(i, msg.action || {}); }
      catch (e) { if (e instanceof GameError) return err(e.message); throw e; }
      sendGame(g);
      if (g.over) settleGame(g);
      return;
    }
    case 'claimWin': {
      const g = games.get(userGame.get(u.id));
      if (!g || g.over) return;
      const i = g.players.findIndex(p => p.userId === u.id);
      const other = g.players[1 - i].userId;
      const since = offlineSince.get(other);
      if (sockets.has(other) || !since || Date.now() - since < FORFEIT_AFTER_MS) return err('Przeciwnik jeszcze może wrócić – poczekaj.');
      g.say(`${g.players[1 - i].name} opuścił grę – walkower.`);
      g.finish(i, 'forfeit');
      sendGame(g); settleGame(g);
      return;
    }
    // ---------- panel administratora ----------
    case 'adminList': case 'adminSetDust': case 'adminSetGold': case 'adminAddGold': case 'adminSetPacks': case 'adminResetPassword': {
      if (!isAdmin(u)) return err('Brak uprawnień administratora.');
      if (t !== 'adminList') {
        const target = userById(msg.id);
        if (!target) return err('Nie ma takiego gracza.');
        const num = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : null; };
        if (t === 'adminSetGold') {
          const g = num(msg.gold); if (g === null || g < 0 || g > 1e9) return err('Zła ilość złota.');
          target.gold = g;
        } else if (t === 'adminAddGold') {
          const g = num(msg.amount); if (g === null || Math.abs(g) > 1e9) return err('Zła ilość złota.');
          target.gold = Math.max(0, target.gold + g);
        } else if (t === 'adminSetDust') {
          const g = num(msg.dust); if (g === null || g < 0 || g > 1e9) return err('Zła ilość pyłu.');
          target.dust = g;
        } else if (t === 'adminSetPacks') {
          const a = num(msg.std), b = num(msg.leg);
          if (a === null || b === null || a < 0 || b < 0 || a > 10000 || b > 10000) return err('Zła liczba paczek.');
          target.packs = { std: a, leg: b };
        } else if (t === 'adminResetPassword') {
          Object.assign(target, hashPassword(DEFAULT_PASSWORD)); target.sessions = [];
        }
        scheduleSave(); sendMe(target); broadcastLobby();
        sendTo(target.id, { t: 'toast', msg: t === 'adminResetPassword' ? 'Administrator zresetował Twoje hasło.' : 'Administrator zmienił Twoje konto.' });
        send(ws, { t: 'toast', msg: `Zapisano: ${target.username}` });
      }
      return send(ws, { t: 'adminUsers', users: db.users.map(x => ({ id: x.id, username: x.username, avatar: x.avatar, gold: x.gold, dust: x.dust, packs: x.packs, stats: x.stats, online: sockets.has(x.id), cards: Object.values(x.collection).reduce((a, b) => a + b, 0) })) });
    }
    case 'cashOut': {
      const n = u.defeated.length, gold = CASH_OUT[n];
      if (!gold) return err('Wypłata jest możliwa przy 3/5 albo 4/5 pokonanych graczy.');
      u.gold += gold; u.defeated = []; u.stats.cashOuts = (u.stats.cashOuts || 0) + 1;
      scheduleSave(); sendMe(u); broadcastLobby();
      return send(ws, { t: 'toast', msg: `Wypłacono ${gold} złota – seria zaczyna się od nowa.` });
    }
    case 'spectate': {
      const target = userById(msg.userId);
      const gid = target && userGame.get(target.id);
      const g = gid && games.get(gid);
      if (!g || g.over) return err('Ten gracz nie jest teraz w grze.');
      if (userGame.has(u.id)) return err('Nie możesz oglądać, gdy sam grasz.');
      stopSpectating(u.id);
      if (!spectators.has(g.id)) spectators.set(g.id, new Set());
      spectators.get(g.id).add(u.id);
      send(ws, { t: 'game', view: g.spectatorView() });
      for (const p of g.players) sendTo(p.userId, { t: 'toast', msg: `${u.username} ogląda Waszą grę 👀` });
      broadcastLobby();
      return;
    }
    case 'stopSpectate': stopSpectating(u.id); broadcastLobby(); return;
    case 'ping': return send(ws, { t: 'pong' });
    default: return err('Nieznana wiadomość.');
  }
}

// ---------------- start ----------------
async function main() {
  await loadDb();
  const app = express();
  // HTML/JS/CSS zawsze sprawdzane na serwerze (po aktualizacji gracze od razu mają nową wersję),
  // obrazki mogą leżeć w pamięci przeglądarki dłużej
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, file) {
      if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }));
  app.get('/health', (_req, res) => res.send('ok'));
  // lista kont na ekran logowania
  app.get('/api/cards', (_req, res) => res.json(PUBLIC_CARDS.map(c => ({ name: c.name, art: c.art }))));
  app.get('/api/users', (_req, res) => res.json(db.users.map(u => ({ username: u.username, avatar: u.avatar }))));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try { handle(ws, msg); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Błąd serwera.' }); }
    });
    ws.on('close', () => {
      if (ws.userId && sockets.get(ws.userId) === ws) {
        const id = ws.userId;
        sockets.delete(id);
        challenges.delete(id);
        stopSpectating(id);
        offlineSince.set(id, Date.now());
        const gid = userGame.get(id);
        const g = gid && games.get(gid);
        if (g && !g.over) {
          const other = g.players.find(p => p.userId !== id);
          sendTo(other.userId, { t: 'opponentLeft', at: Date.now(), waitMs: FORFEIT_AFTER_MS });
        }
        broadcastLobby();
      }
    });
  });

  // utrzymywanie połączeń (hostingi zamykają bezczynne WebSockety)
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 25_000);

  server.listen(PORT, () => console.log(`DCG działa na http://localhost:${PORT}  (dane: ${store.describe()})`));

  if (process.env.RENDER && !process.env.DATABASE_URL) {
    console.warn('UWAGA: brak DATABASE_URL – na Render dane (konta, złoto, karty) znikną przy każdym restarcie! Ustaw bazę Neon.');
  }

  // Utrzymywanie serwera przy życiu: darmowy Render usypia po 15 min bez ruchu,
  // więc serwer co 10 min odwiedza sam siebie pod publicznym adresem.
  // RENDER_EXTERNAL_URL Render ustawia automatycznie; gdzie indziej można podać KEEPALIVE_URL.
  const selfUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && process.env.KEEPALIVE !== 'off') {
    const ping = () => fetch(selfUrl.replace(/\/$/, '') + '/health').catch(e => console.warn('keepalive:', e.message));
    setInterval(ping, 10 * 60_000).unref();
    console.log(`Keepalive włączony: ${selfUrl}/health co 10 min`);
  }

  // przy restarcie/wdrożeniu najpierw zapisujemy dane
  let closing = false;
  const shutdown = async sig => {
    if (closing) return; closing = true;
    console.log(`${sig} – zapisuję dane i kończę…`);
    clearTimeout(saveTimer);
    try { await store.save(db); } catch (e) { console.error('Błąd zapisu przy zamykaniu:', e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
