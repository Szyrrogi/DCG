// Silnik walki – cała logika gry działa na serwerze, klienci tylko wysyłają akcje.
// Przeniesione z: GameManager.cs, CardEffects.cs, PassiveEffectsManager.cs,
// DiscardSystem.cs, PlayerManaManager.cs, ManaColumn.cs, BoardDropZone.cs.
'use strict';

const CARDS = require('./cards.json');
const BY_NAME = Object.fromEntries(CARDS.map(c => [c.name, c]));

const START_HP = 20;
const MAX_HP = 200;            // jak w HealFriendlyHero
const START_HAND = 3;
const HAND_LIMIT = 10;
const BOARD_LIMIT = 7;
const MANA_COSTS = [1, 1, 2, 2]; // koszt kolejnych kul many (ManaColumn.upgradeCosts)
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
  /**
   * @param {string} id
   * @param {{userId:string,name:string,avatar:number,deck:string[]}[]} seats
   * @param {() => number} rng
   */
  constructor(id, seats, rng = Math.random) {
    this.id = id;
    this.rng = rng;
    this.players = seats.map(s => ({
      userId: s.userId,
      name: s.name,
      avatar: s.avatar || 1,
      hp: START_HP,
      deck: shuffle(s.deck.filter(n => BY_NAME[n]).map(n => this.newCard(n)), rng),
      hand: [],
      board: [],
      grave: [],
      mana: { T: { lvl: 0, prog: 0, used: 0 }, W: { lvl: 0, prog: 0, used: 0 }, B: { lvl: 0, prog: 0, used: 0 } },
      manaActionUsed: false,
      fatigue: 0,
    }));
    this.current = rng() < 0.5 ? 0 : 1;
    this.turnNo = 0;
    this.over = false;
    this.winner = null;
    this.endReason = null;
    this.log = [];
    this.fx = [];
    this.seq = 0;
    this.turnStartedAt = Date.now();
  }

  // ---------- pomocnicze ----------
  newCard(name) { return { uid: 'c' + (uidCounter++), name }; }
  data(c) { return BY_NAME[c.name]; }
  opp(i) { return 1 - i; }
  say(text) { this.log.push({ n: this.seq, text }); if (this.log.length > 60) this.log.shift(); }
  pick(arr) { return arr.length ? arr[Math.floor(this.rng() * arr.length)] : null; }
  hasTag(c, tag) { const d = this.data(c); return d.type === 'unit' && (d.tags || []).includes(tag); }
  heroId(i) { return 'hero' + i; }

  start() {
    for (let k = 0; k < START_HAND; k++) { this.draw(0); this.draw(1); }
    this.say(`Zaczyna ${this.players[this.current].name}.`);
    this.startTurn(this.current);
  }

  // ---------- mana ----------
  available(p, city) { const m = p.mana[city]; return m.lvl - m.used; }

  effectiveCost(i, card) {
    const d = this.data(card);
    const cost = { ...d.cost };
    if (d.type === 'spell') {
      const discount = this.players[i].board.filter(u => this.data(u).passive === 'SongsDiscounted').length;
      cost.D = Math.max(0, cost.D - discount);
    }
    return cost;
  }

  canPay(p, cost) {
    for (const c of CITIES) if (this.available(p, c) < cost[c]) return false;
    const rest = CITIES.reduce((s, c) => s + this.available(p, c) - cost[c], 0);
    return rest >= cost.D;
  }

  pay(p, cost) {
    for (const c of CITIES) p.mana[c].used += cost[c];
    let need = cost.D;
    while (need > 0) {
      // płacimy "dowolną" z miasta, którego zostało najwięcej
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

  // ---------- karty ----------
  draw(i, count = 1) {
    const p = this.players[i];
    for (let k = 0; k < count; k++) {
      if (p.deck.length === 0) {
        p.fatigue++;
        this.damageHero(i, p.fatigue, 'zmęczenie');
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
    p.hand.push({ uid: card.uid, name: card.name });
    this.fx.push({ type: 'draw', by: i });
    return true;
  }

  summon(i, card, { battlecry = true, fromPlay = false } = {}) {
    const p = this.players[i];
    if (p.board.length >= BOARD_LIMIT) { this.say(`Plansza ${p.name} jest pełna – ${card.name} przepada.`); p.grave.push(card.name); return null; }
    const d = this.data(card);
    const unit = {
      uid: card.uid, name: card.name,
      atk: d.atk, hp: d.hp, maxHp: d.hp,
      attacksLeft: d.charge ? this.attacksPerTurn(card) : 0,
      frozen: false, turnsAlive: 0,
    };
    p.board.push(unit);
    this.fx.push({ type: 'summon', uid: unit.uid });
    if (!fromPlay) this.say(`${card.name} pojawia się na planszy ${p.name}.`);
    if (battlecry && d.effect) this.runEffect(d.effect, d.value, i, false, unit);
    return unit;
  }

  attacksPerTurn(c) { return this.data(c).passive === 'TwoAttacks' ? 2 : 1; }

  attackOf(i, unit) {
    const d = this.data(unit);
    let a = unit.atk;
    if (d.passive === 'DoubleAttackIfAgnieszka' && this.players[i].board.some(u => u.name.includes('Agnieszka'))) a *= 2;
    return Math.max(0, a);
  }

  damageUnit(unit, amount) {
    if (amount <= 0) return;
    unit.hp -= amount;
    this.fx.push({ type: 'dmg', id: unit.uid, amount });
  }

  damageHero(i, amount) {
    if (amount <= 0) return;
    this.players[i].hp -= amount;
    this.fx.push({ type: 'dmg', id: this.heroId(i), amount });
  }

  healHero(i, amount) {
    const p = this.players[i];
    p.hp = Math.min(MAX_HP, p.hp + amount);
    this.fx.push({ type: 'heal', id: this.heroId(i), amount });
  }

  destroyUnit(i, unit) {
    const p = this.players[i];
    const idx = p.board.indexOf(unit);
    if (idx < 0) return;
    p.board.splice(idx, 1);
    p.grave.push(unit.name);
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

  // DiscardSystem: odrzucenie karty z ręki
  discard(i, card) {
    const p = this.players[i];
    const idx = p.hand.indexOf(card);
    if (idx < 0) return;
    p.hand.splice(idx, 1);
    const d = this.data(card);
    const jedrek = p.board.some(u => this.data(u).passive === 'PlayDiscardedUnits');
    if (d.type === 'unit' && (jedrek || d.passive === 'SummonWhenDiscarded') && p.board.length < BOARD_LIMIT) {
      this.say(`${card.name} zamiast na cmentarz trafia na planszę!`);
      this.summon(i, card, { battlecry: true, fromPlay: true });
      return;
    }
    p.grave.push(card.name);
    this.say(`${p.name} odrzuca ${card.name}.`);
  }

  discardRandom(i) {
    const c = this.pick(this.players[i].hand);
    if (c) this.discard(i, c);
  }

  spellPower(i) {
    return this.players[i].board.reduce((s, u) => s + (this.data(u).spellPower || 0), 0);
  }

  // ---------- efekty (CardEffects.cs) ----------
  runEffect(effect, value, i, isSpell, src, target) {
    const o = this.opp(i);
    const me = this.players[i], them = this.players[o];
    if (isSpell && effect.includes('Damage')) value += this.spellPower(i);
    const progInHand = () => me.hand.some(c => this.hasTag(c, 'Informatyk'));

    switch (effect) {
      case 'HealFriendlyHero': this.healHero(i, value); this.say(`${me.name} leczy się o ${value}.`); break;
      case 'DamageEnemyHero': this.damageHero(o, value); this.say(`${them.name} otrzymuje ${value} obrażeń.`); break;
      case 'SummonGirlfriends': {
        let n = 0;
        const girls = me.deck.filter(c => this.hasTag(c, 'Dziewczyna')).reverse().slice(0, 3);
        for (const c of girls) {
          const k = me.deck.indexOf(c);
          if (k < 0 || me.board.length >= BOARD_LIMIT) continue;
          me.deck.splice(k, 1); this.summon(i, c); n++;
        }
        this.say(`Przywołano ${n} dziewczyn(y) z talii.`);
        break;
      }
      case 'DestroyAllMinionsDiscardHand': {
        for (const pi of [0, 1]) for (const u of this.players[pi].board.slice()) if (u !== src) this.destroyUnit(pi, u);
        for (const c of me.hand.slice()) { me.hand.splice(me.hand.indexOf(c), 1); me.grave.push(c.name); }
        this.say(`Wszystkie inne jednostki zniszczone, ${me.name} odrzuca całą rękę.`);
        break;
      }
      case 'SetHealthTo30': me.hp = 30; this.fx.push({ type: 'heal', id: this.heroId(i), amount: 0 }); this.say(`Zdrowie ${me.name} ustawione na 30.`); break;
      case 'ResurrectRandomUnit': {
        const units = me.grave.filter(n => BY_NAME[n] && BY_NAME[n].type === 'unit');
        const n = this.pick(units);
        if (!n) { this.say('Cmentarz pusty – brak jednostki do wskrzeszenia.'); break; }
        me.grave.splice(me.grave.indexOf(n), 1);
        this.say(`Wskrzeszono ${n}!`);
        this.summon(i, this.newCard(n), { battlecry: false, fromPlay: true });
        break;
      }
      case 'DamageAllExceptProgrammers': {
        if (!progInHand()) { this.say('Brak informatyka w ręce – efekt nie działa.'); break; }
        for (const pi of [0, 1]) for (const u of this.players[pi].board) if (!this.hasTag(u, 'Informatyk')) this.damageUnit(u, value);
        this.say(`${value} obrażeń dla wszystkich poza informatykami.`);
        break;
      }
      case 'ReturnToHandRandom':
        if (src && this.rng() < 0.5 && this.returnToHand(i, src)) this.say(`${src.name} wraca do ręki!`);
        else if (src) this.say(`${src.name} zostaje na planszy.`);
        break;
      case 'ChargeDiscardTwo':
        if (src) src.attacksLeft = this.attacksPerTurn(src);
        this.discardRandom(i); this.discardRandom(i);
        break;
      case 'BuffIfProgrammerInHand': if (src && progInHand()) { src.atk += value; this.say(`${src.name} +${value} ataku.`); } break;
      case 'BuffIfProgrammerInHandHealth': if (src && progInHand()) { src.hp += value; src.maxHp += value; this.say(`${src.name} +${value} zdrowia.`); } break;
      case 'BuffIfProgrammerInHandBoth': if (src && progInHand()) { src.atk += value; src.hp += value; src.maxHp += value; this.say(`${src.name} +${value}/+${value}.`); } break;
      case 'BuffPerCardInHand': if (src) { const n = me.hand.length; src.hp += n; src.maxHp += n; this.say(`${src.name} +${n} zdrowia.`); } break;
      case 'AddRandomSpellToHand': {
        const spells = me.deck.filter(c => this.data(c).type === 'spell');
        const c = this.pick(spells);
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); this.say(`${me.name} dobiera piosenkę.`); }
        break;
      }
      case 'OpponentDiscardsCard': this.discardRandom(o); break;
      case 'DrawCardWithTag': {
        const tag = TAG_BY_INDEX[value];
        const c = me.deck.find(c => this.hasTag(c, tag));
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); this.say(`${me.name} dobiera kartę (${tag}).`); }
        break;
      }
      case 'DrawSpecificCard': {
        const c = me.deck.find(c => ['Julii', 'Jędrek'].includes(c.name));
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.toHand(i, c); this.say(`${me.name} dobiera ${c.name}.`); }
        break;
      }
      case 'Draw5Spells': {
        let n = 0;
        for (let k = me.deck.length - 1; k >= 0 && n < 5; k--) {
          if (this.data(me.deck[k]).type === 'spell') { const [c] = me.deck.splice(k, 1); this.toHand(i, c); n++; }
        }
        this.say(`${me.name} dobiera ${n} piosenek.`);
        break;
      }
      case 'FreezeAllEnemies':
        for (const u of them.board) { u.frozen = true; u.attacksLeft = 0; this.fx.push({ type: 'freeze', id: u.uid }); }
        this.say(`Jednostki ${them.name} zamrożone.`);
        break;
      case 'DamageRandomEnemy3Times':
        for (let k = 0; k < 3; k++) {
          const alive = them.board.filter(u => u.hp > 0);
          const t = this.pick(alive);
          if (t) this.damageUnit(t, value); else this.damageHero(o, value);
        }
        break;
      case 'DestroyTargetMinion': {
        let t = target ? them.board.find(u => u.uid === target) : null;
        if (!t) t = this.pick(them.board);
        if (t) { this.destroyUnit(o, t); this.say(`${t.name} zniszczony.`); }
        break;
      }
      case 'SummonRandomUnit': {
        const c = this.pick(me.deck.filter(c => this.data(c).type === 'unit'));
        if (c) { me.deck.splice(me.deck.indexOf(c), 1); this.summon(i, c); }
        break;
      }
      case 'DamageAllEnemies':
        for (const u of them.board) this.damageUnit(u, value);
        this.say(`${value} obrażeń dla wszystkich jednostek ${them.name}.`);
        break;
      case 'DamageAndDiscard':
        this.damageHero(o, value); this.say(`${them.name} otrzymuje ${value} obrażeń.`);
        this.discardRandom(i);
        break;
      case 'IncreaseBydgoszczMana': this.addManaProgress(me, 'B'); this.say(`${me.name} rozbudowuje Bydgoszcz.`); break;
      case 'DiscardCardFromHand': this.discardRandom(i); break;
      case 'ReturnFriendlyToHand': {
        const t = this.pick(me.board.filter(u => u !== src));
        if (t && this.returnToHand(i, t)) this.say(`${t.name} wraca do ręki.`);
        break;
      }
      case 'SetEnemyHealthToYours': them.hp = me.hp; this.fx.push({ type: 'heal', id: this.heroId(o), amount: 0 }); this.say(`Zdrowie ${them.name} ustawione na ${me.hp}.`); break;
      case 'DamageSelfAndDraw': this.damageHero(i, value); this.draw(i); break;
      case 'DamageBothHeroes': this.damageHero(i, value); this.damageHero(o, value); this.say(`Obaj bohaterowie otrzymują ${value} obrażeń.`); break;
      case '': case 'None': break;
      default: this.say(`(nieznany efekt: ${effect})`);
    }
  }

  // ---------- tury ----------
  startTurn(i) {
    this.current = i;
    this.turnNo++;
    this.turnStartedAt = Date.now();
    const p = this.players[i];
    for (const c of CITIES) p.mana[c].used = 0;
    p.manaActionUsed = false;
    this.draw(i);
    for (const u of p.board) {
      // zamrożona jednostka traci ataki w tej turze; lód topnieje na końcu tury
      u.attacksLeft = u.frozen ? 0 : this.attacksPerTurn(u);
    }
    // jednostki, które giną po X turach
    for (const u of p.board.slice()) {
      const d = this.data(u);
      if (d.turnsUntilDeath > 0) {
        u.turnsAlive++;
        if (u.turnsAlive >= d.turnsUntilDeath) { this.destroyUnit(i, u); this.say(d.hiddenDeath ? `${u.name} nagle znika!` : `${u.name} znika.`); }
      }
    }
    this.checkEnd();
  }

  endTurnPassives(i) {
    for (const u of this.players[i].board) {
      u.frozen = false;
      if (this.data(u).passive === 'GainStatEndTurn') { u.atk++; u.hp++; u.maxHp++; this.fx.push({ type: 'buff', id: u.uid }); }
    }
  }

  checkEnd() {
    if (this.over) return true;
    const dead = [0, 1].filter(k => this.players[k].hp <= 0);
    if (dead.length === 0) return false;
    // przy jednoczesnej śmierci przegrywa gracz, którego jest tura (jak w oryginale)
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

  // ---------- akcje graczy ----------
  action(i, a) {
    if (this.over) throw new GameError('Gra się skończyła.');
    this.fx = [];
    if (a.type === 'concede') { this.say(`${this.players[i].name} poddaje się.`); this.finish(this.opp(i), 'concede'); this.seq++; return; }
    if (i !== this.current) throw new GameError('To nie Twoja tura.');
    const p = this.players[i];
    switch (a.type) {
      case 'mana': {
        if (!CITIES.includes(a.city)) throw new GameError('Złe miasto.');
        if (p.manaActionUsed) throw new GameError('Już rozbudowałeś miasto w tej turze.');
        if (!this.addManaProgress(p, a.city)) throw new GameError('To miasto jest już w pełni rozbudowane.');
        p.manaActionUsed = true;
        this.say(`${p.name} rozbudowuje ${CITY_NAMES[a.city]}.`);
        break;
      }
      case 'play': {
        const card = p.hand.find(c => c.uid === a.uid);
        if (!card) throw new GameError('Nie masz tej karty.');
        const d = this.data(card);
        const cost = this.effectiveCost(i, card);
        if (!this.canPay(p, cost)) throw new GameError('Nie stać Cię na tę kartę.');
        if (d.type === 'unit' && p.board.length >= BOARD_LIMIT) throw new GameError('Plansza jest pełna.');
        this.pay(p, cost);
        p.hand.splice(p.hand.indexOf(card), 1);
        this.fx.push({ type: 'play', name: card.name, by: i });
        if (d.type === 'unit') {
          this.say(`${p.name} zagrywa ${card.name}.`);
          this.summon(i, card, { fromPlay: true });
        } else {
          this.say(`${p.name} gra piosenkę ${card.name}.`);
          this.runEffect(d.effect, d.value, i, true, null, a.target);
          for (const u of p.board) if (this.data(u).passive === 'BuffOnSpellCast') { u.atk++; this.fx.push({ type: 'buff', id: u.uid }); }
          p.grave.push(card.name);
        }
        break;
      }
      case 'attack': {
        const u = p.board.find(x => x.uid === a.uid);
        if (!u) throw new GameError('Nie ma takiej jednostki.');
        if (u.attacksLeft <= 0) throw new GameError(u.frozen ? 'Jednostka jest zamrożona.' : 'Ta jednostka nie może teraz atakować.');
        const o = this.opp(i);
        const atk = this.attackOf(i, u);
        if (a.target === 'hero') {
          this.damageHero(o, atk);
          this.say(`${u.name} atakuje bohatera ${this.players[o].name} za ${atk}.`);
        } else {
          const t = this.players[o].board.find(x => x.uid === a.target);
          if (!t) throw new GameError('Zły cel.');
          const back = this.attackOf(o, t);
          this.damageUnit(t, atk);
          this.damageUnit(u, back);
          this.say(`${u.name} atakuje ${t.name}.`);
        }
        this.fx.push({ type: 'attack', from: u.uid, to: a.target === 'hero' ? this.heroId(o) : a.target });
        u.attacksLeft--;
        break;
      }
      case 'end': {
        this.endTurnPassives(i);
        this.say(`${p.name} kończy turę.`);
        this.sweep();
        if (!this.checkEnd()) this.startTurn(this.opp(i));
        break;
      }
      default: throw new GameError('Nieznana akcja.');
    }
    this.sweep();
    this.checkEnd();
    this.seq++;
  }

  // Widok gry z perspektywy gracza i (ukrywa rękę i talię przeciwnika)
  view(i) {
    const me = this.players[i], o = this.players[this.opp(i)];
    const unitView = (pi, u) => ({
      uid: u.uid, name: u.name, atk: this.attackOf(pi, u), hp: u.hp, maxHp: u.maxHp,
      baseAtk: BY_NAME[u.name].atk, baseHp: BY_NAME[u.name].hp,
      canAttack: pi === this.current && u.attacksLeft > 0, attacksLeft: u.attacksLeft, frozen: u.frozen,
      // ukryta zdolność (np. Gustav) – przeciwnik ani właściciel nie widzą licznika
      turnsLeft: BY_NAME[u.name].turnsUntilDeath > 0 && !BY_NAME[u.name].hiddenDeath ? BY_NAME[u.name].turnsUntilDeath - u.turnsAlive : null,
    });
    const pub = (pi) => {
      const p = this.players[pi];
      return {
        name: p.name, userId: p.userId, avatar: p.avatar, hp: Math.max(0, p.hp),
        deckCount: p.deck.length, handCount: p.hand.length, grave: p.grave.slice(),
        board: p.board.map(u => unitView(pi, u)),
        mana: JSON.parse(JSON.stringify(p.mana)), manaActionUsed: p.manaActionUsed,
        spellPower: this.spellPower(pi),
      };
    };
    return {
      id: this.id, seq: this.seq, turnNo: this.turnNo, mySeat: i,
      myTurn: this.current === i, over: this.over,
      winner: this.over ? (this.winner === i ? 'me' : 'opp') : null, endReason: this.endReason,
      me: { ...pub(i), hand: me.hand.map(c => ({ uid: c.uid, name: c.name, cost: this.effectiveCost(i, c), playable: this.current === i && !this.over && this.canPay(me, this.effectiveCost(i, c)) && !(BY_NAME[c.name].type === 'unit' && me.board.length >= BOARD_LIMIT) })) },
      opp: pub(this.opp(i)),
      log: this.log.slice(-30).map(l => l.text),
      fx: this.fx,
      turnStartedAt: this.turnStartedAt,
    };
  }
}

module.exports = { Game, GameError, CARDS, BY_NAME, START_HP, HAND_LIMIT, BOARD_LIMIT };
