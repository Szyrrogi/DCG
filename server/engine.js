// Silnik walki – cała logika gry działa na serwerze
'use strict';

const CARDS = require('./cards.json');
const BY_NAME = Object.fromEntries(CARDS.map(c => [c.name, c]));

const START_HP = 20;
const MAX_HP = 200;
const START_HAND = 3;
const HAND_LIMIT = 10;
const BOARD_LIMIT = 7;
const MANA_COSTS = [1, 1, 2, 2];
const MANA_MAX = 4;
const CITIES = ['T', 'W', 'B'];
const CITY_NAMES = { T: 'Tczew', W: 'Warszawa', B: 'Bydgoszcz' };
const TAG_BY_INDEX = ['Dziewczyna', 'Informatyk', 'Lewc'];

let uidCounter = 1;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class GameError extends Error {}

class Game {
  constructor(id, seats, rng = Math.random) {
    this.id = id;
    this.rng = rng;
    this.players = seats.map(s => ({
      userId: s.userId,
      name: s.name,
      avatar: s.avatar || 1,
      hp: s.hp || START_HP,
      isBot: !!s.isBot,
      openingSpell: s.openingSpell || null,
      turnsTaken: 0,
      originalDeck: s.deck.slice(),
      deck: shuffle(s.deck.filter(n => BY_NAME[n]).map(n => this.newCard(n)), rng),
      hand: [],
      board: [],
      grave: [],
      dead: [],
      mana: { T: { lvl: 0, prog: 0, used: 0 }, W: { lvl: 0, prog: 0, used: 0 }, B: { lvl: 0, prog: 0, used: 0 } },
      manaActionUsed: false,
      fatigue: 0,
      juliiTurns: 0,
      progsPlayed: 0,
      girlsPlayed: 0,
      graveBuff: 0,
      snakeSize: 0,
      reviveNextTurn: []
    }));
    seats.forEach((s, k) => {
      if (s.startMana) for (const c of CITIES) if (s.startMana[c]) this.players[k].mana[c].lvl = Math.min(MANA_MAX, s.startMana[c]);
    });
    this.events = [];
    this.evSeq = 0;
    this.ev = null;
    this.uidInfo = {};
    this.current = rng() < 0.5 ? 0 : 1;
    this.turnNo = 0;
    this.over = false;
    this.winner = null;
    this.endReason = null;
    this.log = [];
    this.fx = [];
    this.seq = 0;
    this.turnStartedAt = Date.now();
    this.phase = 'mulligan';
    this.mulliganDone = [false, false];
    this.pendingQueue = [];
    this.isDraft = false;
  }

  newCard(name) { return { uid: 'c' + (uidCounter++), name }; }

  // kopia stanu do symulacji (AI) – bez dziennika
  clone(rng = Math.random) {
    const g = Object.create(Game.prototype);
    for (const k of Object.keys(this)) {
      if (k === 'rng' || k === 'log' || k === 'events' || k === 'ev' || k === 'uidInfo' || k === 'fx' || typeof this[k] === 'function') continue;
      const v = this[k];
      g[k] = v && typeof v === 'object' ? structuredClone(v) : v;
    }
    g.rng = rng; g.log = []; g.events = []; g.ev = null; g.uidInfo = {}; g.fx = []; g.sim = true;
    return g;
  }

  // ---- dziennik walki (jak historia w Hearthstone) ----
  beginEvent(by, kind, card, extra = {}) {
    if (this.sim) return null;
    this.closeEvent();
    const ev = { id: ++this.evSeq, turn: this.turnNo, by, kind, card, target: null, res: [], draws: [0, 0], ...extra };
    ev.fxStart = this.fx.length;
    this.ev = ev;
    this.events.push(ev);
    if (this.events.length > 40) this.events.shift();
    return ev;
  }
  reopenEvent(id) {
    const ev = id && this.events.find(e => e.id === id);
    if (!ev || ev === this.ev) return;
    this.closeEvent();
    ev.fxStart = this.fx.length;
    this.ev = ev;
  }
  closeEvent() {
    const ev = this.ev; if (!ev) return;
    this.ev = null;
    const list = this.fx.slice(ev.fxStart);
    const get = (id, extra) => {
      let r = ev.res.find(x => x.key === id);
      if (!r) {
        let info;
        if (/^hero[01]$/.test(id)) { const seat = +id[4]; info = { name: this.players[seat].name, seat, hero: true }; }
        else info = this.uidInfo[id];
        if (!info) return null;
        r = { key: id, name: info.name, seat: info.seat, hero: !!info.hero, dmg: 0, heal: 0, ...extra };
        ev.res.push(r);
      }
      return r;
    };
    for (const f of list) {
      if (f.type === 'draw') { ev.draws[f.by]++; continue; }
      if (f.type === 'discard' || f.type === 'burn') { ev.res.push({ key: 'x' + ev.res.length, name: f.name, seat: f.by, [f.type]: true, dmg: 0, heal: 0 }); continue; }
      if (f.type === 'mana') { ev.city = f.city; continue; }
      const id = f.id || f.uid; if (!id) continue;
      if (f.type === 'summon' && id === ev.uid) continue;
      const r = get(id); if (!r) continue;
      if (f.type === 'dmg') r.dmg += f.amount || 0;
      else if (f.type === 'heal') { if (f.amount > 0) r.heal += f.amount; else r.set = this.players[r.seat] && r.hero ? Math.max(0, this.players[r.seat].hp) : true; }
      else if (f.type === 'die') r.died = true;
      else if (f.type === 'buff') r.buff = true;
      else if (f.type === 'summon') r.summon = true;
      else if (f.type === 'freeze') r.frozen = true;
      else if (f.type === 'immune') r.immune = true;
      else if (f.type === 'bounce') r.bounce = true;
    }
    // jednostki/bohaterowie bez żadnej zmiany nie są ciekawe
    ev.res = ev.res.filter(x => x.dmg || x.heal || x.died || x.buff || x.summon || x.frozen || x.immune || x.bounce || x.discard || x.burn || x.set != null);
    if (ev.kind === 'turn' && !ev.res.length) { const k = this.events.indexOf(ev); if (k >= 0) this.events.splice(k, 1); }
  }
  publicEvents() {
    return this.events.slice(-30).map(e => ({ id: e.id, turn: e.turn, by: e.by, kind: e.kind, card: e.card, target: e.target, option: e.option || null, city: e.city || null, auto: !!e.auto, res: e.res, draws: e.draws }));
  }
  data(c) { return BY_NAME[c.name] || BY_NAME[c]; }
  opp(i) { return 1 - i; }
  say(text) { if (this.sim) return; this.log.push({ n: this.seq, text }); if (this.log.length > 60) this.log.shift(); }
  pick(arr) { return arr.length ? arr[Math.floor(this.rng() * arr.length)] : null; }
  hasTag(c, tag) { const d = this.data(c); return d.type === 'unit' && (d.tags || []).includes(tag); }
  heroId(i) { return 'hero' + i; }

  start() {
    for (let k = 0; k < START_HAND; k++) { this.draw(0); this.draw(1); }
    this.draw(this.opp(this.current));
    this.say(`Zaczyna ${this.players[this.current].name}. Wymiana kart startowych…`);
  }

  mulligan(i, uids) {
    if (this.phase !== 'mulligan') throw new GameError('Wymiana kart już się skończyła.');
    if (this.mulliganDone[i]) throw new GameError('Już wymieniłeś karty.');
    const p = this.players[i];
    const out = [...new Set(Array.isArray(uids) ? uids : [])].map(u => p.hand.find(c => c.uid === u)).filter(Boolean);
    for (const c of out) p.hand.splice(p.hand.indexOf(c), 1);
    for (let k = 0; k < out.length; k++) this.draw(i);
    for (const c of out) p.deck.splice(Math.floor(this.rng() * (p.deck.length + 1)), 0, { uid: c.uid, name: c.name, atkMod: c.atkMod });
    this.mulliganDone[i] = true;
    this.say(`${p.name} ${out.length ? `wymienia ${out.length} kart` : 'zostawia rękę'}.`);
    if (this.mulliganDone[0] && this.mulliganDone[1]) {
      this.phase = 'play';
      this.startTurn(this.current);
      this.closeEvent();
    }
  }
  autoMulligan() { for (const i of [0, 1]) if (!this.mulliganDone[i] && !this.over) { this.fx = []; this.mulligan(i, []); } this.seq++; }

  get pending() { return this.pendingQueue[0] || null; }
  queue(q) { q.evId = this.ev ? this.ev.id : null; this.pendingQueue.push(q); }
  resurrectOptions(i) { return [...new Set(this.players[i].dead.filter(n => BY_NAME[n] && BY_NAME[n].type === 'unit'))]; }
  resurrect(i, name) {
    const p = this.players[i];
    p.dead.splice(p.dead.indexOf(name), 1);
    const g = p.grave.lastIndexOf(name); if (g >= 0) p.grave.splice(g, 1);
    this.say(`${p.name} wskrzesza ${name}!`);
    this.summon(i, this.newCard(name), { battlecry: true, fromPlay: true, fromGrave: true });
  }
  resurrectRandom(i) {
    const p = this.players[i];
    const opts = this.resurrectOptions(i);
    if (!opts.length) { this.say('Brak poległych jednostek do wskrzeszenia.'); return; }
    if (p.board.length >= BOARD_LIMIT) { this.say('Plansza pełna – nikt nie wstaje z grobu.'); return; }
    // losujemy spośród wszystkich poległych (więcej kopii = większa szansa), Olaf zawsze pierwszy
    const pool = p.dead.filter(n => BY_NAME[n] && BY_NAME[n].type === 'unit');
    this.resurrect(i, opts.includes('Olaf') ? 'Olaf' : this.pick(pool));
  }

  resolvePending() {
    while (this.pendingQueue.length && !this.over) {
      const q = this.pendingQueue[0], p = this.players[q.player];
      if (q.type === 'discard') {
        if (q.count <= 0 || p.hand.length === 0) { this.pendingQueue.shift(); continue; }
        if (p.hand.length <= q.count) {
          this.pendingQueue.shift();
          this.reopenEvent(q.evId);
          for (const c of p.hand.slice()) this.discard(q.player, c);
          this.sweep();
          continue;
        }
        if (q.player !== this.current) {
          q.count--; if (q.count <= 0) this.pendingQueue.shift();
          this.reopenEvent(q.evId);
          this.discard(q.player, this.pick(p.hand)); this.sweep();
          continue;
        }
        return;
      }
      if (q.type === 'target') {
        q.options = q.options.filter(uid => this.findUnit(uid));
        if (!q.options.length) { this.pendingQueue.shift(); this.say('Brak celu.'); continue; }
        if (q.player !== this.current) { this.choose(q.player, { uid: this.pick(q.options) }); continue; }
        return;
      }
      if (q.type === 'choice') {
        if (!q.options.length) { this.pendingQueue.shift(); continue; }
        if (q.options.length === 1 && q.autoSingle) { this.choose(q.player, { index: 0 }); continue; }
        if (q.player !== this.current) { this.choose(q.player, { index: Math.floor(this.rng() * q.options.length) }); continue; }
        return;
      }
      this.pendingQueue.shift();
    }
  }

  findUnit(uid) {
    for (const pi of [0, 1]) { const u = this.players[pi].board.find(x => x.uid === uid); if (u) return { u, pi }; }
    return null;
  }

  pushTarget(i, ctx, uids, prompt, front = true) {
    const q = { player: i, type: 'target', options: uids, prompt, context: ctx, evId: this.ev ? this.ev.id : null };
    if (front) this.pendingQueue.unshift(q); else this.pendingQueue.push(q);
  }

  choose(i, a) {
    const q = this.pending;
    if (!q || q.player !== i) throw new GameError('Nie ma nic do wybrania.');
    const p = this.players[i], o = this.opp(i);

    if (q.type === 'discard') {
      const c = p.hand.find(x => x.uid === a.uid);
      if (!c) throw new GameError('Wybierz kartę z ręki.');
      q.count--; if (q.count <= 0) this.pendingQueue.shift();
      this.reopenEvent(q.evId);
      this.discard(i, c);
      return;
    }

    if (q.type === 'target') {
      if (!q.options.includes(a.uid)) throw new GameError('Wybierz jedną z podświetlonych jednostek.');
      const f = this.findUnit(a.uid);
      this.pendingQueue.shift();
      this.reopenEvent(q.evId);
      if (!f) return;
      const { u, pi } = f;
      if (this.ev) this.ev.target = this.ev.target || { name: u.name, uid: u.uid, seat: pi };
      switch (q.context.action) {
        case 'pedalBuff':
          u.atk += 3; u.hp += 3; u.maxHp += 3; this.fx.push({ type: 'buff', id: u.uid });
          this.say(`${u.name} otrzymuje +3/+3.`); break;
        case 'pedalKill':
          this.destroyUnit(pi, u); this.say(`${u.name} zostaje zniszczony.`); break;
        case 'astarion': {
          const me = p.board.find(x => x.uid === q.context.uid);
          this.destroyUnit(pi, u); this.say(`${u.name} zostaje poświęcony.`);
          if (me) { me.atk += 2; me.hp += 2; me.maxHp += 2; this.fx.push({ type: 'buff', id: me.uid }); }
          break;
        }
      }
      return;
    }

    if (q.type === 'choice') {
      if (a.index == null || a.index < 0 || a.index >= q.options.length) throw new GameError('Zły wybór.');
      this.pendingQueue.shift();
      this.reopenEvent(q.evId);
      const opt = q.options[a.index];
      if (this.ev) this.ev.option = opt.name;
      switch (q.context.action) {
        case 'olaf': {
          const u = p.board.find(x => x.uid === q.context.uid);
          if (u) u.olafMode = opt.key === 'double' ? 1 : 2;
          break;
        }
        case 'sedoro':
          if (opt.key === 'snake') {
            p.snakeSize = (p.snakeSize || 0) + 1;
            const sn = this.summon(i, this.newCard('Wąż'), { battlecry: false });
            if (sn) { sn.atk = p.snakeSize; sn.hp = p.snakeSize; sn.maxHp = p.snakeSize; }
          } else {
            p.deck.push(this.newCard('Sedoro OST'), this.newCard('Sedoro OST'));
            shuffle(p.deck, this.rng);
            this.say(`Wtasowano 2 Sedoro OST.`);
          }
          break;
        case 'pedal':
          if (opt.key === 'buff') this.pushTarget(i, { action: 'pedalBuff' }, p.board.map(u => u.uid), 'Wybierz swojego stronnika: +3/+3');
          else this.pushTarget(i, { action: 'pedalKill' }, this.players[o].board.filter(u => this.hasTag(u, 'Lewc')).map(u => u.uid), 'Wybierz wrogiego Lewca do zniszczenia');
          break;
        case 'astarion':
          if (opt.key === 'sac') this.pushTarget(i, { action: 'astarion', uid: q.context.uid }, p.board.filter(x => x.uid !== q.context.uid).map(u => u.uid), 'Wybierz stronnika do poświęcenia');
          break;
        case 'manaCity':
          if (this.addManaProgress(p, opt.key)) this.say(`${p.name} rozbudowuje ${CITY_NAMES[opt.key]}.`);
          this.fx.push({ type: 'mana', by: i, city: opt.key });
          break;
      }
    }
  }

  // karty z wyborem, które bez celu nie miałyby żadnego efektu
  castable(i, card) {
    const d = this.data(card), me = this.players[i], them = this.players[this.opp(i)];
    if (d.effect === 'LastPedalChoice') return me.board.length > 0 || them.board.some(u => this.hasTag(u, 'Lewc'));
    if (d.type === 'spell' && (d.effect === 'DestroyTargetMinion' || d.effect === 'DestroyAndOpponentDraws')) return them.board.length > 0;
    return true;
  }

  available(p, city) { const m = p.mana[city]; return m.lvl - m.used; }

  effectiveCost(i, card) {
    const d = this.data(card);
    const cost = { ...d.cost };
    if (d.type === 'spell') {
      let discount = this.players[i].board.filter(u => this.data(u).passive === 'SongsDiscounted').length;
      const fromD = Math.min(cost.D, discount); cost.D -= fromD; discount -= fromD;
      while (discount > 0) {
        const c = CITIES.slice().sort((a, b) => cost[b] - cost[a])[0];
        if (cost[c] <= 0) break;
        cost[c]--; discount--;
      }
    }
    return cost;
  }

  canPay(p, cost) {
    for (const c of CITIES) if (this.available(p, c) < cost[c]) return false;
    const rest = CITIES.reduce((s, c) => s + this.available(p, c) - cost[c], 0);
    return rest >= cost.D;
  }

  validPayChoice(p, cost, choice) {
    if (!choice || typeof choice !== 'object') return false;
    let sum = 0;
    for (const c of CITIES) {
      const n = choice[c] || 0;
      if (!Number.isInteger(n) || n < 0 || n > this.available(p, c) - cost[c]) return false;
      sum += n;
    }
    return sum === cost.D;
  }
  
  pay(p, cost, choice) {
    const ok = this.validPayChoice(p, cost, choice);
    for (const c of CITIES) p.mana[c].used += cost[c];
    if (ok) { for (const c of CITIES) p.mana[c].used += choice[c] || 0; return; }
    let need = cost.D;
    while (need > 0) {
      const best = CITIES.slice().sort((a, b) => this.available(p, b) - this.available(p, a))[0];
      if (this.available(p, best) <= 0) break;
      p.mana[best].used++; need--;
    }
  }

  addManaProgress(p, city) {
    const m = p.mana[city];
    if (m.lvl >= MANA_MAX) return false;
    m.prog++;
    if (m.prog >= MANA_COSTS[m.lvl]) { m.lvl++; m.prog = 0; }
    return true;
  }

  draw(i, count = 1) {
    const p = this.players[i];
    for (let k = 0; k < count; k++) {
      if (p.deck.length === 0) {
        p.fatigue++;
        const own = !this.ev;
        if (own) this.beginEvent(i, 'fatigue', null);
        if (this.ev && this.ev.kind === 'turn') this.ev.kind = 'fatigue';
        this.damageHero(i, p.fatigue, null, 'zmęczenie');
        if (own) this.closeEvent();
        this.say(`${p.name} nie ma kart w talii – zmęczenie zadaje ${p.fatigue} obrażeń.`);
        continue;
      }
      const c = p.deck.shift();
      this.toHand(i, c);
    }
  }

  toHand(i, card) {
    const p = this.players[i];
    if (p.hand.length >= HAND_LIMIT) {
      p.grave.push(card.name);
      this.say(`${p.name} ma pełną rękę – ${card.name} spala się.`);
      this.fx.push({ type: 'burn', by: i, name: card.name });
      return false;
    }
    p.hand.push({ uid: card.uid, name: card.name, atkMod: card.atkMod });
    this.fx.push({ type: 'draw', by: i });
    return true;
  }

  summon(i, card, { battlecry = true, fromPlay = false, fromGrave = false } = {}) {
    const p = this.players[i];
    if (p.board.length >= BOARD_LIMIT) { this.say(`Plansza pełna – ${card.name} przepada.`); p.grave.push(card.name); return null; }
    const d = this.data(card);
    const unit = {
      uid: card.uid, name: card.name,
      atk: Math.floor(d.atk * (card.atkMod || 1)), hp: d.hp, maxHp: d.hp,
      attacksLeft: d.charge ? this.attacksPerTurn(card) : 0,
      frozen: false, turnsAlive: 0,
    };
    
    if (d.passive === 'BuffEverywhereOnGirl') {
        unit.atk += (p.girlsPlayed || 0); unit.hp += (p.girlsPlayed || 0); unit.maxHp += (p.girlsPlayed || 0);
    }
    if (fromGrave && p.graveBuff) {
        unit.atk += p.graveBuff; unit.hp += p.graveBuff; unit.maxHp += p.graveBuff;
    }
    if (d.passive === 'BuffIfEnemyHasXayoo' && this.players[this.opp(i)].originalDeck.includes('Xayoo "Legenda"')) {
        unit.atk += 2; unit.hp -= 1; unit.maxHp -= 1;
    }

    p.board.push(unit);
    this.uidInfo[unit.uid] = { name: unit.name, seat: i };
    this.fx.push({ type: 'summon', uid: unit.uid });
    if (!fromPlay) this.say(`${card.name} pojawia się na planszy ${p.name}.`);
    
    if (fromPlay && card.name !== 'Pudzian') {
        const pudzians = p.board.filter(u => u !== unit && u.name === 'Pudzian');
        for (const pdz of pudzians) {
            if (d.effect) {
                pdz.atk += 2; this.fx.push({ type: 'buff', id: pdz.uid });
                unit.atk += 1; unit.hp += 1; unit.maxHp += 1; this.fx.push({ type: 'buff', id: unit.uid });
            }
        }
    }

    if (battlecry && d.effect) {
        const times = p.board.some(u => this.data(u).passive === 'DoubleBattlecry') ? 2 : 1;
        for (let bc = 0; bc < times; bc++) this.runEffect(d.effect, d.value, i, false, unit);
    }
    return unit;
  }

  attacksPerTurn(c) { return this.data(c).passive === 'TwoAttacks' ? 2 : 1; }

  attackOf(i, unit) {
    let a = unit.atk;
    if (unit.name === 'Olaf' && unit.olafMode === 1 && this.players[i].board.some(u => u.name === 'Agnieszka')) a *= 2;
    const idx = this.players[i].board.indexOf(unit);
    if (idx >= 0) {
        const hasRowerAdj = (idx > 0 && this.players[i].board[idx-1].name === 'Rower') || (idx < this.players[i].board.length - 1 && this.players[i].board[idx+1].name === 'Rower');
        if (hasRowerAdj) { a += 2; if (unit.name === 'Błażej') a += 2; }
    }
    return Math.max(0, a);
  }

  damageUnit(unit, amount, sourceUnit = null) {
    if (amount <= 0) return;
    unit.hp -= amount;
    this.fx.push({ type: 'dmg', id: unit.uid, amount });
    if (sourceUnit && this.data(sourceUnit).passive === 'Lifesteal') {
        const owner = this.players[0].board.includes(sourceUnit) ? 0 : 1;
        this.healHero(owner, amount);
    }
  }

  heroImmune(i) { return this.players[i].board.some(u => this.data(u).passive === 'HeroImmune'); }
  
  damageHero(i, amount, sourceUnit = null, reason = '') {
    if (amount <= 0) return;
    if (this.heroImmune(i)) { this.fx.push({ type: 'immune', id: this.heroId(i) }); return; }
    const dmg = this.players[i].juliiTurns > 0 ? amount * 3 : amount;
    this.players[i].hp -= dmg;
    this.fx.push({ type: 'dmg', id: this.heroId(i), amount: dmg });
    if (sourceUnit && this.data(sourceUnit).passive === 'Lifesteal') {
        const owner = this.players[0].board.includes(sourceUnit) ? 0 : 1;
        this.healHero(owner, dmg);
    }
  }

  healHero(i, amount) {
    const p = this.players[i];
    p.hp = Math.min(MAX_HP, p.hp + amount);
    this.fx.push({ type: 'heal', id: this.heroId(i), amount });
  }

  destroyUnit(i, unit, { vanish = false } = {}) {
    const p = this.players[i];
    const idx = p.board.indexOf(unit);
    if (idx < 0) return;
    p.board.splice(idx, 1);
    p.grave.push(unit.name);
    if (!vanish) {
        p.dead.push(unit.name);
        if (this.data(unit).passive === 'ReviveOnce' && !unit.revived) {
            p.reviveNextTurn.push(unit.name);
        }
    }
    this.fx.push({ type: 'die', id: unit.uid });
  }

  sweep() {
    for (let i = 0; i < 2; i++) {
      for (const u of this.players[i].board.slice()) {
        if (u.hp <= 0) { this.destroyUnit(i, u); this.say(`${u.name} ginie.`); }
      }
    }
  }

  returnToHand(i, unit) {
    const p = this.players[i];
    const idx = p.board.indexOf(unit);
    if (idx < 0) return false;
    if (p.hand.length >= HAND_LIMIT) return false;
    p.board.splice(idx, 1);
    p.hand.push({ uid: unit.uid, name: unit.name });
    this.fx.push({ type: 'bounce', id: unit.uid });
    return true;
  }

  discard(i, card) {
    const p = this.players[i];
    const idx = p.hand.indexOf(card);
    if (idx < 0) return;
    p.hand.splice(idx, 1);
    
    // DODANA LINIJKA - Informacja dla interfejsu o odrzuceniu
    this.fx.push({ type: 'discard', by: i, name: card.name });

    const d = this.data(card);
    const jedrek = p.board.some(u => this.data(u).passive === 'PlayDiscardedUnits');
    
    if (d.passive === 'DamageOnDiscard') {
        const t = this.pick(this.players[this.opp(i)].board);
        if (t) { this.damageUnit(t, 4); this.say(`${card.name} zadaje 4 obrażenia ${t.name}!`); }
    }
    for (const u of p.board) if (this.data(u).passive === 'DrawOnDiscard') this.draw(i);
    
    if (d.type === 'unit' && (jedrek || d.passive === 'SummonWhenDiscarded') && p.board.length < BOARD_LIMIT) {
      this.say(`${card.name} zamiast na cmentarz trafia na planszę!`);
      this.summon(i, card, { battlecry: true, fromPlay: true });
      return;
    }
    p.grave.push(card.name);
    if (d.type === 'unit') p.dead.push(card.name);
    this.say(`${p.name} odrzuca ${card.name}.`);
  }

  discardRandom(i) {
    const c = this.pick(this.players[i].hand);
    if (c) this.discard(i, c);
  }

  spellPower(i) {
    let sp = this.players[i].board.reduce((s, u) => s + (this.data(u).spellPower || 0), 0);
    const hasAga = this.players[i].board.some(u => u.name === 'Agnieszka');
    for (const u of this.players[i].board) if (u.name === 'Olaf' && u.olafMode === 2 && hasAga) sp += 2;
    return sp;
  }

  runEffect(effect, value, i, isSpell, src, target) {
    const o = this.opp(i);
    const me = this.players[i], them = this.players[o];
    if (isSpell && (effect.includes('Damage') || effect.includes('Heal'))) value += this.spellPower(i);
    const progInHand = () => me.hand.some(c => this.hasTag(c, 'Informatyk'));

    switch (effect) {
      case 'HealFriendlyHero': this.healHero(i, value); this.say(`${me.name} leczy się o ${value}.`); break;
      case 'DamageEnemyHero': this.damageHero(o, value); this.say(`${them.name} otrzymuje ${value} obrażeń.`); break;
      case 'BuffIfEnemyHasXayoo':
        if (src && this.players[this.opp(i)].originalDeck.includes('Xayoo')) {
            src.atk += 2; src.hp -= 1; src.maxHp -= 1;
            this.fx.push({type:'buff', id:src.uid});
            this.say(`${src.name} wykrywa Xayoo u przeciwnika i zyskuje +2/-1!`);
        }
        break;
      case 'SummonGirlfriends': {
        let n = 0;
        const girls = me.deck.filter(c => this.hasTag(c, 'Dziewczyna')).reverse().slice(0, 3);
        for (const c of girls) {
          const k = me.deck.indexOf(c);
          if (k < 0 || me.board.length >= BOARD_LIMIT) continue;
          me.deck.splice(k, 1); this.summon(i, c); n++;
        }
        this.say(`Przywołano ${n} dziewczyn z talii.`);
        break;
      }
      case 'DestroyAllMinionsDiscardHand': {
        for (const pi of [0, 1]) for (const u of this.players[pi].board.slice()) if (u !== src) this.destroyUnit(pi, u);
        for (const c of me.hand.slice()) { 
            me.hand.splice(me.hand.indexOf(c), 1); 
            this.fx.push({ type: 'discard', by: i, name: c.name }); // DODANA LINIJKA
            me.grave.push(c.name); 
            if (this.data(c).type === 'unit') me.dead.push(c.name); 
        }
        this.say(`Wszystkie inne jednostki zniszczone, odrzucono rękę.`);
        break;
      }
      case 'SetHealthTo30': me.hp = 30; this.fx.push({ type: 'heal', id: this.heroId(i), amount: 0 }); this.say(`Zdrowie ustawione na 30.`); break;
      case 'ResurrectFriendlyUnit': this.resurrectRandom(i); break;
      case 'DamageAllExceptProgrammers': {
        if (!progInHand()) { this.say('Brak informatyka w ręce.'); break; }
        for (const pi of [0, 1]) for (const u of this.players[pi].board) if (!this.hasTag(u, 'Informatyk')) this.damageUnit(u, value);
        this.say(`${value} obrażeń poza informatykami.`);
        break;
      }
      case 'ChanceBuff': {
        if (!src) break;
        const hp = BY_NAME[src.name].valueHp != null ? BY_NAME[src.name].valueHp : value;
        if (this.rng() < 0.5) { src.atk += value; src.hp += hp; src.maxHp += hp; this.fx.push({ type: 'buff', id: src.uid }); }
        break;
      }
      case 'DrawCards': this.draw(i, value); this.say(`${me.name} dobiera ${value} karty.`); break;
      case 'DrawNamedCard': {
        const name = BY_NAME[src ? src.name : ''] && BY_NAME[src.name].drawName;
        const c = me.deck.find(x => x.name === name);
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); }
        break;
      }
      case 'ReturnToHandRandom': if (src && this.rng() < 0.5 && this.returnToHand(i, src)) this.say(`${src.name} wraca do ręki!`); break;
      case 'ChargeDiscardTwo':
        if (src) src.attacksLeft = this.attacksPerTurn(src);
        this.queue({ player: i, type: 'discard', count: 2 });
        break;
      case 'BuffAndChargeIfProgrammerInHand': 
        if (src && progInHand()) { src.atk += value; src.hp += value; src.maxHp += value; src.attacksLeft = this.attacksPerTurn(src); this.fx.push({type:'buff', id:src.uid}); } break;
      case 'BuffAndTauntIfProgrammerInHand':
        if (src && progInHand()) { src.atk += value; src.taunt = true; this.fx.push({type:'buff', id:src.uid}); } break;
      case 'BuffIfProgrammerInHandBoth': {
        const hp = BY_NAME[src ? src.name : ''] && BY_NAME[src.name].valueHp != null ? BY_NAME[src.name].valueHp : value;
        if (src && progInHand()) { src.atk += value; src.hp += hp; src.maxHp += hp; this.fx.push({type:'buff', id:src.uid}); } break;
      }
      case 'BuffPerCardInHand': if (src) { const n = me.hand.length; src.hp += n; src.maxHp += n; } break;
      case 'AddRandomSpellToHand': {
        const spells = me.deck.filter(c => this.data(c).type === 'spell');
        const c = this.pick(spells);
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); }
        break;
      }
      case 'OpponentDiscardsCard': this.discardRandom(o); break;
      case 'DrawCardWithTag': case 'DrawTwoWithTag': {
        const tag = TAG_BY_INDEX[value];
        for (let k = 0; k < (effect === 'DrawTwoWithTag' ? 2 : 1); k++) {
          const c = me.deck.find(x => this.hasTag(x, tag));
          if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); }
        }
        break;
      }
      case 'DrawSpecificCard': {
        for (const name of ['Julii', 'Jędrek']) {
          const c = me.deck.find(x => x.name === name);
          if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); }
        }
        break;
      }
      case 'Draw5Spells': {
        let n = 0;
        for (let k = me.deck.length - 1; k >= 0 && n < 5; k--) {
          if (this.data(me.deck[k]).type === 'spell') { const [c] = me.deck.splice(k, 1); this.toHand(i, c); n++; }
        }
        break;
      }
      case 'FreezeAllEnemies':
        for (const u of them.board) { u.frozen = true; u.attacksLeft = 0; this.fx.push({ type: 'freeze', id: u.uid }); }
        break;
      case 'DamageRandomEnemy3Times':
        for (let k = 0; k < 3; k++) {
          const t = this.pick([...them.board.filter(u => u.hp > 0), 'hero']);
          if (t === 'hero') this.damageHero(o, value); else this.damageUnit(t, value);
        }
        break;
      case 'DestroyTargetMinion': {
        let t = target ? them.board.find(u => u.uid === target) : null;
        if (!t) t = this.pick(them.board);
        if (t) this.destroyUnit(o, t);
        break;
      }
      case 'SummonRandomUnit': {
        const c = this.pick(me.deck.filter(x => this.data(x).type === 'unit'));
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.summon(i, c); }
        break;
      }
      case 'DamageAllEnemies':
        for (const u of them.board) this.damageUnit(u, value);
        break;
      case 'DamageAndDiscard': {
        const t = target && target !== 'hero' ? them.board.find(u => u.uid === target) : null;
        if (t) this.damageUnit(t, value); else this.damageHero(o, value);
        this.queue({ player: i, type: 'discard', count: 1 });
        break;
      }
      case 'HalfBydgoszczMana': case 'ManaCrystal': {
        const opts = CITIES.filter(c => me.mana[c].lvl < MANA_MAX).map(c => {
          const m = me.mana[c], need = MANA_COSTS[m.lvl];
          return { key: c, name: CITY_NAMES[c], desc: m.prog + 1 >= need ? `Nowa kula: ${m.lvl} → ${m.lvl + 1}` : `Budowa kuli: ${m.prog + 1}/${need}` };
        });
        if (!opts.length) { this.say('Wszystkie miasta są już rozbudowane.'); break; }
        this.queue({ player: i, type: 'choice', options: opts, context: { action: 'manaCity' }, autoSingle: true });
        break;
      }
      case 'DiscardCardFromHand': this.queue({ player: i, type: 'discard', count: 1 }); break;
      case 'ReturnFriendlyToHand': {
        const t = this.pick(me.board.filter(u => u !== src));
        if (t && this.returnToHand(i, t)) this.say(`${t.name} wraca do ręki.`);
        break;
      }
      case 'SetEnemyHealthTo': them.hp = value; this.fx.push({ type: 'heal', id: this.heroId(o), amount: 0 }); this.say(`Zdrowie ${them.name} ustawione na ${value}!`); break;
      case 'SetEnemyHealthToYours': them.hp = me.hp; this.fx.push({ type: 'heal', id: this.heroId(o), amount: 0 }); break;
      case 'DamageSelfAndDraw': this.damageHero(i, value); this.draw(i); break;
      case 'DamageBothHeroes': this.damageHero(i, value); this.damageHero(o, value); break;
      case 'TripleDamage3Turns': 
        me.hp = 30; 
        this.fx.push({ type: 'heal', id: this.heroId(i), amount: 0 });
        me.juliiTurns = 3; 
        this.say(`Zdrowie ustawione na 30. Julii zadziałała – bohater będzie otrzymywać x3 obrażeń!`); 
        break;
      case 'BothPlayersDraw2': this.draw(i, 2); this.draw(o, 2); break;
      case 'DestroyAndOpponentDraws': {
        const tgt = target ? them.board.find(u => u.uid === target) : null;
        if (tgt) this.destroyUnit(o, tgt);
        this.draw(o, 2);
        break;
      }
      case 'DiscardAndDraw2': this.queue({ player: i, type: 'discard', count: 1 }); this.draw(i, 2); break;
      case 'BuffGraveyard': me.graveBuff = (me.graveBuff || 0) + 2; this.say(`Cmentarz wzmocniony +2/+2.`); break;
      case 'SummonTwoCopies': 
        if (src) { this.summon(i, this.newCard(src.name), { battlecry: false }); this.summon(i, this.newCard(src.name), { battlecry: false }); } break;
      case 'HalveAttack3Random': {
        const targets = shuffle([...them.hand, ...them.deck].filter(c => BY_NAME[c.name] && BY_NAME[c.name].type === 'unit'), this.rng).slice(0, 3);
        for (const t of targets) t.atkMod = (t.atkMod || 1) * 0.5;
        this.say(`Tequila osłabia 3 jednostki.`);
        break;
      }
      case 'SummonDragonsForProgrammers': {
        let spawned = 0;
        for (let k = 0; k < (me.progsPlayed || 0) && me.board.length < BOARD_LIMIT; k++) {
            this.summon(i, this.newCard('Smok'), { battlecry: false, fromPlay: true }); spawned++;
        }
        this.say(`Przywołano ${spawned} smoków.`);
        break;
      }
      case 'DebuffLegends':
        for (const u of them.board) {
            if (BY_NAME[u.name] && BY_NAME[u.name].rarity === 3) { u.atk -= 2; u.hp -= 2; u.maxHp -= 2; this.fx.push({type:'dmg', id:u.uid, amount:0}); }
        }
        break;
      case 'DestroyTargetGirl': {
        const tgtGirl = target ? them.board.find(u => u.uid === target) : null;
        if (tgtGirl && this.hasTag(tgtGirl, 'Dziewczyna')) this.destroyUnit(o, tgtGirl);
        else { const randGirl = this.pick(them.board.filter(u => this.hasTag(u, 'Dziewczyna'))); if (randGirl) this.destroyUnit(o, randGirl); }
        break;
      }
      case 'DamageGrass':
        for (const pi of [0, 1]) {
            for (const u of this.players[pi].board) {
                if (this.hasTag(u, 'Dziewczyna')) continue;
                if (this.hasTag(u, 'Informatyk')) this.damageUnit(u, 3 + value);
                else this.damageUnit(u, 1 + value);
            }
        }
        break;
      case 'OlafChoice': {
        const aga = me.deck.find(x => x.name === 'Agnieszka');
        if (aga) { me.deck.splice(me.deck.indexOf(aga), 1); this.toHand(i, aga); this.say(`${me.name} dobiera Agnieszkę.`); }
        if (src) this.queue({ player: i, type: 'choice', options: [{ key: 'double', name: 'Podwójny atak', desc: 'Dopóki Agnieszka jest na planszy, Olaf ma podwójny atak' }, { key: 'sp', name: 'Moc pieśni', desc: 'Dopóki Agnieszka jest na planszy: +2 Mocy pieśni' }], context: { uid: src.uid, action: 'olaf' } });
        break;
      }
      case 'SedoroChoice':
        this.queue({ player: i, type: 'choice', options: [{ key: 'snake', name: 'Wąż', desc: 'Przywołaj węża (każdy kolejny jest większy)' }, { key: 'ost', name: 'OST', desc: 'Wtasuj 2 „Sedoro OST” do talii' }], context: { action: 'sedoro' } }); break;
      case 'LastPedalChoice':
      {
        const opts = [];
        if (me.board.length) opts.push({ key: 'buff', name: 'Wzmocnij', desc: 'Wybrany Twój stronnik dostaje +3/+3' });
        if (them.board.some(u => this.hasTag(u, 'Lewc'))) opts.push({ key: 'kill', name: 'Zniszcz Lewca', desc: 'Zniszcz wybranego wrogiego Lewca' });
        if (!opts.length) { this.say('Ostatni pedał nie ma celu.'); break; }
        this.queue({ player: i, type: 'choice', options: opts, context: { action: 'pedal' } }); break;
      }
      case 'AstarionChoice':
        if (src && me.board.some(u => u !== src)) this.queue({ player: i, type: 'choice', options: [{ key: 'sac', name: 'Poświęć', desc: 'Zniszcz wybranego swojego stronnika, Astarion dostaje +2/+2' }, { key: 'skip', name: 'Pomiń', desc: 'Nic nie rób' }], context: { uid: src.uid, action: 'astarion' } }); break;
      case 'SummonScalingSnake':
        me.snakeSize = (me.snakeSize || 0) + 1;
        const snake = this.summon(i, this.newCard('Wąż'), { battlecry: false });
        if (snake) { snake.atk = me.snakeSize; snake.hp = me.snakeSize; snake.maxHp = me.snakeSize; }
        break;
      case '': case 'None': break;
    }
  }

  startTurn(i) {
    this.current = i;
    this.turnNo++;
    this.turnStartedAt = Date.now();
    const p = this.players[i];
    for (const c of CITIES) p.mana[c].used = 0;
    p.manaActionUsed = false;
    
    if (p.juliiTurns > 0) p.juliiTurns--;
    p.turnsTaken = (p.turnsTaken || 0) + 1;
    this.beginEvent(i, 'turn', null);
    
    if (p.reviveNextTurn && p.reviveNextTurn.length) {
        for (const name of p.reviveNextTurn) {
            this.say(`${name} wraca na planszę!`);
            const u = this.summon(i, this.newCard(name), { battlecry: false });
            if (u) u.revived = true;
        }
        p.reviveNextTurn = [];
    }

    this.draw(i);
    this.closeEvent();
    for (const u of p.board.slice()) {
      if (!p.board.includes(u)) continue;
      u.attacksLeft = u.frozen ? 0 : this.attacksPerTurn(u);
      if (this.data(u).passive === 'GainStatStartTurn') { u.atk++; u.hp++; u.maxHp++; this.fx.push({ type: 'buff', id: u.uid }); }
      if (this.data(u).passive === 'DestroyAllStartTurn') {
          this.beginEvent(i, 'trigger', u.name, { uid: u.uid });
          for (const pi of [0, 1]) for (const target of this.players[pi].board.slice()) this.destroyUnit(pi, target);
          this.say(`${u.name} niszczy wszystkich stronników!`);
          this.closeEvent();
          continue;
      }
      
      const d = this.data(u);
      if (d.turnsUntilDeath > 0) {
        u.turnsAlive++;
        if (u.turnsAlive >= d.turnsUntilDeath) { this.destroyUnit(i, u, { vanish: true }); }
      }
    }
    if (p.openingSpell && p.turnsTaken === 1 && !this.over) {
      const sp = BY_NAME[p.openingSpell];
      this.beginEvent(i, 'spell', sp.name);
      this.fx.push({ type: 'play', name: sp.name, by: i });
      this.say(`${p.name} rzuca ${sp.name}!`);
      this.runEffect(sp.effect, sp.value, i, false, null);
      this.closeEvent();
    }
    this.checkEnd();
  }

  endTurnPassives(i) {
    const p = this.players[i];
    for (const u of p.board) {
      u.frozen = false;
      if (this.data(u).passive === 'GainStatEndTurn') { u.atk++; u.hp++; u.maxHp++; this.fx.push({ type: 'buff', id: u.uid }); }
      if (this.data(u).passive === 'AutoAttackEndTurn') {
          const targets = [...this.players[this.opp(i)].board, 'hero'];
          const t = this.pick(targets);
          this.beginEvent(i, 'attack', u.name, { uid: u.uid, auto: true });
          if (this.ev) this.ev.target = t === 'hero' ? { name: this.players[this.opp(i)].name, hero: true, seat: this.opp(i) } : { name: t.name, uid: t.uid, seat: this.opp(i) };
          const atk = this.attackOf(i, u);
          this.say(`${u.name} na koniec tury atakuje ${t === 'hero' ? this.players[this.opp(i)].name : t.name}.`);
          if (t === 'hero') this.damageHero(this.opp(i), atk, u);
          else this.damageUnit(t, atk, u);
          this.closeEvent();
      }
    }
  }

  checkEnd() {
    if (this.over) return true;
    const dead = [0, 1].filter(k => this.players[k].hp <= 0);
    if (dead.length === 0) return false;
    const loser = dead.length === 2 ? this.current : dead[0];
    this.finish(this.opp(loser), 'hp');
    return true;
  }

  finish(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.endReason = reason;
    this.say(`KONIEC GRY – wygrywa ${this.players[winner].name}!`);
  }

  action(i, a) {
    if (this.over) throw new GameError('Gra się skończyła.');
    this.fx = [];
    this.ev = null;
    if (a.type === 'concede') { this.say(`${this.players[i].name} poddaje się.`); this.finish(this.opp(i), 'concede'); this.seq++; return; }
    if (a.type === 'mulligan') { this.mulligan(i, a.uids); this.seq++; return; }
    if (this.phase === 'mulligan') throw new GameError('Najpierw wymiana kart startowych.');
    if (i !== this.current) throw new GameError('To nie Twoja tura.');
    const p = this.players[i];
    if (this.pending && a.type !== 'choose' && a.type !== 'choiceIndex') throw new GameError(this.pending.type === 'discard' ? 'Najpierw wybierz kartę do odrzucenia.' : 'Najpierw dokonaj wyboru.');
    
    switch (a.type) {
      case 'choose': this.choose(i, a); break;
      case 'choiceIndex': this.choose(i, a); break;
      case 'mana': {
        if (!CITIES.includes(a.city)) throw new GameError('Złe miasto.');
        if (p.manaActionUsed) throw new GameError('Już rozbudowałeś miasto w tej turze.');
        if (!this.addManaProgress(p, a.city)) throw new GameError('To miasto jest już w pełni rozbudowane.');
        p.manaActionUsed = true;
        break;
      }
      case 'play': {
        let card, cost, fromGrave = false;
        if (a.uid && a.uid.startsWith('g_')) {
            const idx = parseInt(a.uid.substring(2));
            const name = p.grave[idx];
            if (!name || !BY_NAME[name] || BY_NAME[name].passive !== 'PlayableFromGraveyard') throw new GameError('Zła karta.');
            card = { uid: 'c' + (uidCounter++), name };
            cost = { T:0, W:0, B:0, D:2 };
            fromGrave = true;
        } else {
            card = p.hand.find(c => c.uid === a.uid);
            if (!card) throw new GameError('Nie masz tej karty.');
            cost = this.effectiveCost(i, card);
        }
        
        const d = this.data(card);
        if (!this.canPay(p, cost)) throw new GameError('Nie stać Cię na tę kartę.');
        if (d.type === 'unit' && p.board.length >= BOARD_LIMIT) throw new GameError('Plansza jest pełna.');
        if (!this.castable(i, card)) throw new GameError('Ta karta nie ma teraz żadnego celu.');
        this.pay(p, cost, a.pay);
        
        if (fromGrave) {
            const idx = parseInt(a.uid.substring(2));
            p.grave.splice(idx, 1);
            const di = p.dead.lastIndexOf(card.name); if (di >= 0) p.dead.splice(di, 1);
        } else {
            p.hand.splice(p.hand.indexOf(card), 1);
        }
        
        if (this.hasTag(card, 'Informatyk')) p.progsPlayed = (p.progsPlayed || 0) + 1;
        if (this.hasTag(card, 'Dziewczyna')) {
            p.girlsPlayed = (p.girlsPlayed || 0) + 1;
            for (const u of p.board) if (this.data(u).passive === 'BuffEverywhereOnGirl') { u.atk++; u.hp++; u.maxHp++; this.fx.push({type:'buff', id:u.uid}); }
        }
        
        this.fx.push({ type: 'play', name: card.name, by: i });
        this.beginEvent(i, d.type === 'unit' ? 'play' : 'spell', card.name, { uid: card.uid, fromGrave });
        {
          const tgt = a.target === 'hero' ? this.players[this.opp(i)].name : a.target ? (this.players[this.opp(i)].board.find(x => x.uid === a.target) || {}).name : null;
          this.say(`${p.name} ${d.type === 'unit' ? 'zagrywa' : 'rzuca'} ${card.name}${fromGrave ? ' z cmentarza' : ''}${tgt && (d.target || d.type === 'spell') ? ` → ${tgt}` : ''}.`);
        }
        if (a.target) {
          const tu = a.target === 'hero' ? null : this.players[this.opp(i)].board.find(x => x.uid === a.target);
          if (!this.ev) {} else if (a.target === 'hero') this.ev.target = { name: this.players[this.opp(i)].name, hero: true, seat: this.opp(i) };
          else if (tu) this.ev.target = { name: tu.name, uid: tu.uid, seat: this.opp(i) };
        }
        if (d.type === 'unit') {
          this.summon(i, card, { fromPlay: true, fromGrave });
          if (d.endsTurn) this.autoEndTurn = true;
        } else {
          this.runEffect(d.effect, d.value, i, true, null, a.target);
          for (const u of p.board) if (this.data(u).passive === 'BuffAtkOnSpellCast') { u.atk++; this.fx.push({ type: 'buff', id: u.uid }); }
          p.grave.push(card.name);
        }
        break;
      }
      case 'attack': {
        const u = p.board.find(x => x.uid === a.uid);
        if (!u) throw new GameError('Nie ma takiej jednostki.');
        if (this.data(u).passive === 'AutoAttackEndTurn') throw new GameError('Ta jednostka nie może atakować ręcznie.');
        if (u.attacksLeft <= 0) throw new GameError(u.frozen ? 'Ta jednostka jest zamrożona.' : 'Ta jednostka nie może teraz atakować.');
        const o = this.opp(i);
        const taunts = this.players[o].board.filter(x => this.data(x).taunt || x.taunt);
        if (taunts.length && !taunts.some(x => x.uid === a.target)) throw new GameError('Najpierw musisz zaatakować jednostkę z Prowokacją.');
        const atk = this.attackOf(i, u);
        this.beginEvent(i, 'attack', u.name, { uid: u.uid });
        {
          const tn = a.target === 'hero' ? this.players[o].name : (this.players[o].board.find(x => x.uid === a.target) || {}).name;
          if (tn) this.say(`${u.name} atakuje ${tn} (${atk} obr.).`);
        }
        if (a.target === 'hero') {
          if (this.ev) this.ev.target = { name: this.players[o].name, hero: true, seat: o };
          this.damageHero(o, atk, u);
        } else {
          const t = this.players[o].board.find(x => x.uid === a.target);
          if (!t) throw new GameError('Zły cel.');
          if (this.ev) this.ev.target = { name: t.name, uid: t.uid, seat: o };
          const back = this.attackOf(o, t);
          this.damageUnit(t, atk, u);
          this.damageUnit(u, back, t);
          if (this.data(u).passive === 'DamageHeroOnAttack') {
              this.damageHero(o, atk, u, 'Stuu');
          }
        }
        this.fx.push({ type: 'attack', from: u.uid, to: a.target === 'hero' ? this.heroId(o) : a.target });
        u.attacksLeft--;
        break;
      }
      case 'end': {
        this.say(`${this.players[i].name} kończy turę.`);
        this.endTurnPassives(i);
        this.sweep();
        if (!this.checkEnd()) this.startTurn(this.opp(i));
        break;
      }
      default: throw new GameError('Nieznana akcja.');
    }
    this.sweep();
    this.resolvePending();
    this.sweep();
    this.checkEnd();
    if (this.autoEndTurn && !this.pending && !this.over && this.current === i) {
      this.autoEndTurn = false;
      this.say(`${this.players[i].name} – tura kończy się automatycznie.`);
      this.endTurnPassives(i);
      this.sweep();
      if (!this.checkEnd()) this.startTurn(this.opp(i));
    }
    this.closeEvent();
    this.seq++;
  }

  pendingSource() {
    const q = this.pending; if (!q || !q.evId) return null;
    const ev = this.events.find(e => e.id === q.evId);
    return ev ? ev.card : null;
  }

  view(i) {
    const me = this.players[i], o = this.players[this.opp(i)];
    const unitView = (pi, u) => ({
      uid: u.uid, name: u.name, atk: this.attackOf(pi, u), hp: u.hp, maxHp: u.maxHp,
      baseAtk: BY_NAME[u.name].atk, baseHp: BY_NAME[u.name].hp,
      canAttack: this.phase === 'play' && !this.pending && pi === this.current && u.attacksLeft > 0 && this.data(u).passive !== 'AutoAttackEndTurn',
      taunt: !!BY_NAME[u.name].taunt || !!u.taunt, attacksLeft: u.attacksLeft, frozen: u.frozen,
      turnsLeft: BY_NAME[u.name].turnsUntilDeath > 0 && !BY_NAME[u.name].hiddenDeath ? BY_NAME[u.name].turnsUntilDeath - u.turnsAlive : null,
    });
    const pub = (pi) => {
      const p = this.players[pi];
      return {
        name: p.name, userId: p.userId, avatar: p.avatar, hp: Math.max(0, p.hp),
        deckCount: p.deck.length, handCount: p.hand.length, grave: p.grave.slice(),
        board: p.board.map(u => unitView(pi, u)),
        mana: JSON.parse(JSON.stringify(p.mana)), manaActionUsed: p.manaActionUsed,
        spellPower: this.spellPower(pi), immune: this.heroImmune(pi),
      };
    };
    
    const gravePlayables = me.grave.map((n, idx) => ({ n, idx })).filter(x => BY_NAME[x.n] && BY_NAME[x.n].passive === 'PlayableFromGraveyard').map(({ n, idx }) => ({
        uid: 'g_' + idx, name: n, cost: { T:0, W:0, B:0, D:2 }, playable: this.phase === 'play' && !this.pending && this.current === i && !this.over && this.canPay(me, { T:0, W:0, B:0, D:2 }) && me.board.length < BOARD_LIMIT 
    }));

    return {
      id: this.id, seq: this.seq, turnNo: this.turnNo, mySeat: i, currentSeat: this.current,
      myTurn: this.phase === 'play' && this.current === i, over: this.over,
      phase: this.phase, mulliganEndsAt: this.mulliganEndsAt || null, spectator: false,
      mulligan: this.phase === 'mulligan' ? { me: this.mulliganDone[i], opp: this.mulliganDone[this.opp(i)] } : null,
      pending: this.pending ? (this.pending.player === i
        ? { mine: true, type: this.pending.type, count: this.pending.count || 0, options: this.pending.options || null, prompt: this.pending.prompt || null, source: this.pendingSource() }
        : { mine: false, type: this.pending.type }) : null,
      winner: this.over ? (this.winner === i ? 'me' : 'opp') : null, endReason: this.endReason,
      me: { ...pub(i), hand: [...me.hand.map(c => ({ uid: c.uid, name: c.name, cost: this.effectiveCost(i, c), playable: this.phase === 'play' && !this.pending && this.current === i && !this.over && this.canPay(me, this.effectiveCost(i, c)) && !(BY_NAME[c.name].type === 'unit' && me.board.length >= BOARD_LIMIT) && this.castable(i, c) })), ...gravePlayables] },
      opp: pub(this.opp(i)),
      log: this.log.slice(-30).map(l => l.text),
      events: this.publicEvents(),
      fx: this.fx, turnStartedAt: this.turnStartedAt,
    };
  }
}

Game.prototype.spectatorView = function () {
  const v = this.view(0);
  const handOf = pi => this.players[pi].hand.map(c => ({ uid: c.uid, name: c.name, cost: this.effectiveCost(pi, c), playable: false }));
  v.spectator = true; v.myTurn = false;
  v.me.hand = handOf(0); v.opp.hand = handOf(1);
  if (v.pending) v.pending = { mine: false, type: v.pending.type || this.pending.type, who: this.players[this.pending.player].name };
  v.mulligan = this.phase === 'mulligan' ? { me: this.mulliganDone[0], opp: this.mulliganDone[1] } : null;
  v.currentName = this.players[this.current].name;
  return v;
};

module.exports = { Game, GameError, CARDS, BY_NAME, START_HP, HAND_LIMIT, BOARD_LIMIT, CITIES, MANA_COSTS, MANA_MAX };