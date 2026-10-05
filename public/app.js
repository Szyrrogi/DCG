'use strict';
// ================= stan =================
const S = {
  ws: null, token: null, me: null, cards: [], byName: {},
  lobby: { players: [], challenges: [], history: [] },
  view: null, prevView: null, sel: null, // sel: {kind:'attacker'|'spell', uid}
  edit: null,  // edytowana talia {id, name, cards[]}
  reconnectDelay: 500, gameOverShown: false, avatarCards: {}, regAvatar: null, market: { offers: [], trades: [] }, mGive: null, mWant: null,
};
const CITY = { T: 'Tczew', W: 'Warszawa', B: 'Bydgoszcz' };
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// awatar: 'f1'..'f9' (portrety) albo 'c:<nazwa karty>' (grafika karty)
const isCardAv = a => typeof a === 'string' && a.startsWith('c:');
function face(a) {
  if (isCardAv(a)) { const c = S.byName[a.slice(2)] || S.avatarCards[a.slice(2)]; return c ? `img/art/${c.art}` : 'img/face_1.webp'; }
  const n = typeof a === 'number' ? a : parseInt(String(a || 'f1').slice(1), 10) || 1;
  return `img/face_${n}.webp`;
}
const avImg = (a, cls = '') => `<img class="${cls} ${isCardAv(a) ? 'cav' : ''}" src="${face(a)}" alt="">`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* brak */ } },
};

// ================= połączenie =================
function connect() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const ws = new WebSocket(url);
  S.ws = ws;
  $('#conn-status').textContent = 'Łączenie z serwerem…';
  // darmowy hosting może „spać” – pierwsze połączenie trwa wtedy do minuty
  clearTimeout(S.wakeTimer);
  S.wakeTimer = setTimeout(() => { if (ws.readyState !== 1) $('#conn-status').textContent = 'Serwer się budzi – to może potrwać do minuty…'; }, 3000);
  ws.onopen = () => {
    S.reconnectDelay = 500;
    $('#conn-status').textContent = 'Połączono.';
    const t = store.get('dcg_token');
    if (t) send({ t: 'resume', token: t });
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    $('#conn-status').textContent = 'Brak połączenia – ponawiam…';
    if (S.me) toast('Utracono połączenie – łączę ponownie…', true);
    setTimeout(connect, S.reconnectDelay);
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 8000);
  };
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); else toast('Brak połączenia z serwerem.', true); }

function onMsg(m) {
  switch (m.t) {
    case 'auth':
      S.token = m.token; store.set('dcg_token', m.token);
      S.cards = m.cards; S.byName = Object.fromEntries(m.cards.map(c => [c.name, c]));
      setMe(m.me);
      if (!S.view || S.view.over) show('hub');
      showRegister(false); $('#register-form').reset(); S.regAvatar = null;
      break;
    case 'registerError': $('#reg-error').textContent = m.msg; break;
    case 'adminUsers': renderAdmin(m.users); break;
    case 'loginError':
      store.set('dcg_token', null);
      S.me = null; show('login');
      if (!m.silent) $('#login-error').textContent = m.msg;
      break;
    case 'me': setMe(m.me); break;
    case 'market': S.market = m; renderMarket(); break;
    case 'lobby': S.lobby = m; renderLobby(); break;
    case 'challenged': showChallenge(m.from, m.fromName); break;
    case 'game': onGame(m.view); break;
    case 'gameOver': onGameOver(m); break;
    case 'opponentLeft': onOpponentLeft(m); break;
    case 'opponentBack': $('#opp-left').classList.add('hidden'); toast(m.msg); break;
    case 'packOpened': showPack(m.kind, m.cards); break;
    case 'deckSaved': if (S.edit) { S.edit.id = m.id; } toast('Talia zapisana.'); closeEditor(); break;
    case 'toast': toast(m.msg); break;
    case 'error': toast(m.msg, true); break;
    case 'kicked': store.set('dcg_token', null); S.me = null; S.ws = null; show('login'); $('#login-error').textContent = m.msg; break;
  }
}

// ================= ekrany =================
function show(name) {
  for (const s of ['login', 'hub', 'game']) $('#scr-' + s).classList.toggle('hidden', s !== name);
}
function setTab(tab) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-body').forEach(b => b.classList.toggle('hidden', b.id !== 'tab-' + tab));
  if (tab === 'collection') renderCollection();
  if (tab === 'profile') renderProfile();
  if (tab === 'admin') send({ t: 'adminList' });
  if (tab === 'market') renderMarket();
}
$$('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), Math.max(err ? 4200 : 3000, msg.length * 60));
}
function modal(html) { $('#modal-box').innerHTML = html; $('#modal').classList.remove('hidden'); return $('#modal-box'); }
function closeModal() { $('#modal').classList.add('hidden'); }

// ================= logowanie =================
async function renderLoginUsers() {
  let users = [];
  try { users = await (await fetch('api/users')).json(); } catch { /* serwer niedostępny */ }
  $('#login-users').innerHTML = users.map(u => `<button type="button" data-u="${esc(u.username)}">${avImg(u.avatar)}<span>${esc(u.username)}</span></button>`).join('');
  $$('#login-users button').forEach(b => b.onclick = () => {
    $$('#login-users button').forEach(x => x.classList.toggle('sel', x === b));
    $('#login-user').value = b.dataset.u; $('#login-pass').focus();
  });
}

// ---------- zakładanie konta ----------
async function loadAvatarCards() {
  if (Object.keys(S.avatarCards).length) return;
  try { const list = await (await fetch('api/cards')).json(); S.avatarCards = Object.fromEntries(list.map(c => [c.name, c])); } catch { }
}
function cardAvatarGrid(selected) {
  const cards = Object.values(Object.keys(S.byName).length ? S.byName : S.avatarCards).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  return cards.map(c => `<button type="button" class="${selected === 'c:' + c.name ? 'sel' : ''}" data-av="c:${esc(c.name)}" title="${esc(c.name)}"><img class="cav" src="img/art/${c.art}" alt=""><span>${esc(c.name)}</span></button>`).join('');
}
async function showRegister(on) {
  $('#login-form').classList.toggle('hidden', on);
  $('#register-form').classList.toggle('hidden', !on);
  if (!on) return;
  await loadAvatarCards();
  renderRegAvatars();
}
function renderRegAvatars() {
  $('#reg-avatars').innerHTML = cardAvatarGrid(S.regAvatar);
  $$('#reg-avatars button').forEach(b => b.onclick = () => { S.regAvatar = b.dataset.av; renderRegAvatars(); });
}
$('#btn-show-register').onclick = () => showRegister(true);
$('#btn-back-login').onclick = () => showRegister(false);
$('#register-form').onsubmit = e => {
  e.preventDefault();
  const err = $('#reg-error'); err.textContent = '';
  if ($('#reg-pass').value !== $('#reg-pass2').value) { err.textContent = 'Hasła nie są takie same.'; return; }
  if (!S.regAvatar) { err.textContent = 'Wybierz zdjęcie profilowe – kliknij jedną z kart.'; return; }
  send({ t: 'register', username: $('#reg-user').value, password: $('#reg-pass').value, avatar: S.regAvatar });
};
$('#login-form').onsubmit = e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  send({ t: 'login', username: $('#login-user').value, password: $('#login-pass').value });
};
$('#btn-logout').onclick = () => {
  send({ t: 'logout', token: S.token });
  store.set('dcg_token', null); S.me = null; $('#login-pass').value = ''; show('login');
};

// ================= profil gracza =================
function setMe(me) {
  S.me = me;
  $('#me-gold').textContent = me.gold;
  $('#me-name').textContent = me.username;
  $('#me-avatar').src = face(me.avatar); $('#me-avatar').classList.toggle('cav', isCardAv(me.avatar));
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', !me.isAdmin));
  $('#cnt-std').textContent = me.packs.std;
  $('#cnt-leg').textContent = me.packs.leg;
  // edytowana talia nie może mieć kart, których już nie masz (np. po wymianie)
  if (S.edit) {
    const c = {};
    S.edit.cards = S.edit.cards.filter(n => (c[n] = (c[n] || 0) + 1) <= (me.collection[n] || 0));
  }
  renderDeckSelect();
  renderLobby();
  renderMarket();
  if (!$('#tab-collection').classList.contains('hidden')) renderCollection();
  if (!$('#tab-profile').classList.contains('hidden')) renderProfile();
}

function deckProblem(deck) {
  const size = S.me.rules.deckSize;
  if (deck.cards.length < size) { const k = size - deck.cards.length; return `${k} ${k === 1 ? 'puste miejsce' : k < 5 ? 'puste miejsca' : 'pustych miejsc'} – uzupełnij`; }
  if (deck.cards.length !== size) return `${deck.cards.length}/${size} kart`;
  const cnt = countBy(deck.cards);
  for (const [n, k] of Object.entries(cnt)) if (k > (S.me.collection[n] || 0)) return `brakuje: ${n}`;
  return null;
}
const countBy = arr => arr.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});

function renderDeckSelect() {
  const sel = $('#play-deck');
  const prev = sel.value || store.get('dcg_deck');
  const decks = S.me.decks.filter(d => !deckProblem(d));
  sel.innerHTML = decks.length ? decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('') : '<option value="">— brak gotowej talii —</option>';
  if (decks.some(d => d.id === prev)) sel.value = prev;
  $('#play-deck-hint').innerHTML = decks.length ? '' : 'Najpierw zbuduj talię 20 kart w zakładce <b>Kolekcja</b> (możesz kliknąć „Uzupełnij”).';
}
$('#play-deck').onchange = e => store.set('dcg_deck', e.target.value);

// ================= lobby =================
function renderLobby() {
  if (!S.me) return;
  const { players, challenges, history } = S.lobby;
  const myOut = challenges.find(c => c.from === S.me.id);
  $('#lobby-list').innerHTML = players.map(p => {
    const isMe = p.id === S.me.id;
    const incoming = challenges.find(c => c.from === p.id && c.to === S.me.id);
    let status = p.inGame ? '<span class="dot game"></span>w grze' : p.online ? '<span class="dot on"></span>online' : '<span class="dot"></span>offline';
    let btn = '';
    if (isMe) btn = '<span class="muted small">to Ty</span>';
    else if (incoming) btn = `<button class="btn gold small" data-accept="${p.id}">Przyjmij wyzwanie</button>`;
    else if (myOut && myOut.to === p.id) btn = `<button class="btn ghost small" data-cancel="1">Anuluj wyzwanie</button>`;
    else btn = `<button class="btn small" data-challenge="${p.id}" ${!p.online || p.inGame || myOut ? 'disabled' : ''}>Wyzwij</button>`;
    const beaten = S.me.defeated.includes(p.id) ? ' <span class="gold-t small" title="Pokonany w tej serii">✔</span>' : '';
    return `<div class="player-row ${isMe ? 'me' : ''}">${avImg(p.avatar)}<div class="info"><div class="name">${esc(p.username)}${beaten}</div><div class="small muted">${status} · ${p.stats.wins}W / ${p.stats.losses}P</div></div>${btn}</div>`;
  }).join('');
  $$('[data-challenge]').forEach(b => b.onclick = () => {
    const deckId = $('#play-deck').value;
    if (!deckId) return toast('Najpierw wybierz gotową talię.', true);
    send({ t: 'challenge', to: b.dataset.challenge, deckId });
  });
  $$('[data-cancel]').forEach(b => b.onclick = () => send({ t: 'cancelChallenge' }));
  $$('[data-accept]').forEach(b => b.onclick = () => { const p = players.find(x => x.id === b.dataset.accept); showChallenge(p.id, p.username); });

  // bonus
  const others = players.filter(p => p.id !== S.me.id);
  $('#bonus-track').innerHTML = others.map(p => {
    const d = S.me.defeated.includes(p.id);
    return `<div class="slot ${d ? 'done' : ''}">${avImg(p.avatar)}<div>${esc(p.username)}</div><div>${d ? '✔ pokonany' : '—'}</div></div>`;
  }).join('') + `<div class="slot" style="align-self:center;font-size:14px"><b class="gold-t">${S.me.defeated.length}/${S.me.rules.bonusDistinct}</b></div>`;

  // ranking
  $('#rank-body').innerHTML = players.slice().sort((a, b) => b.stats.wins - a.stats.wins || a.stats.losses - b.stats.losses)
    .map(p => `<tr><td>${esc(p.username)}</td><td>${p.stats.wins}</td><td>${p.stats.losses}</td><td>${p.stats.bonuses}</td><td class="gold-t">${p.gold}</td></tr>`).join('');
  $('#history').innerHTML = (history || []).map(h => `<li><b>${esc(h.winner)}</b> pokonał(a) ${esc(h.loser)}${h.reason === 'concede' ? ' (poddanie)' : h.reason === 'forfeit' ? ' (walkower)' : ''}${h.bonus ? ' <span class="gold-t">+100 bonus!</span>' : ''} <span class="muted small">${new Date(h.at).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></li>`).join('') || '<li class="muted">Jeszcze nikt nie grał.</li>';
}

function showChallenge(fromId, fromName) {
  const decks = S.me.decks.filter(d => !deckProblem(d));
  const p = S.lobby.players.find(x => x.id === fromId);
  const box = modal(`
    ${avImg(p ? p.avatar : 'f1', 'av')}
    <h2>${esc(fromName)} wyzywa Cię na pojedynek!</h2>
    ${decks.length ? `<label>Wybierz talię<select id="acc-deck">${decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>` : '<p class="error">Nie masz gotowej talii (20 kart). Zbuduj ją w Kolekcji.</p>'}
    <div class="row center"><button class="btn gold" id="acc-yes" ${decks.length ? '' : 'disabled'}>Walczymy!</button><button class="btn ghost" id="acc-no">Odrzuć</button></div>`);
  const pref = $('#play-deck').value;
  if (pref && box.querySelector('#acc-deck') && decks.some(d => d.id === pref)) box.querySelector('#acc-deck').value = pref;
  box.querySelector('#acc-yes').onclick = () => { send({ t: 'acceptChallenge', from: fromId, deckId: box.querySelector('#acc-deck').value }); closeModal(); };
  box.querySelector('#acc-no').onclick = () => { send({ t: 'declineChallenge', from: fromId }); closeModal(); };
}

// ================= karty (HTML) =================
function costHtml(cost, base) {
  let h = '';
  if (cost.D > 0 || (cost.T + cost.W + cost.B === 0)) h += `<i class="D ${base && cost.D < base.D ? 'cheap' : ''}">${cost.D}</i>`;
  for (const c of ['T', 'W', 'B']) for (let k = 0; k < cost[c]; k++) h += `<i class="${c}" title="${CITY[c]}"></i>`;
  return `<div class="cost">${h}</div>`;
}
function cardHtml(name, o = {}) {
  const c = S.byName[name];
  if (!c) return '';
  const cls = ['card', 'r' + c.rarity, o.cls || ''].join(' ');
  const tag = c.type === 'unit' && c.tags && c.tags.length ? `<div class="tg">${esc(c.tags.join(', '))}</div>` : '';
  const stats = c.type === 'unit'
    ? `<div class="stat a">${c.atk}</div><div class="stat h">${c.hp}</div>`
    : '<div class="song">♪ PIOSENKA ♪</div>';
  const cnt = o.count != null ? `<div class="cnt">×${o.count}</div>` : '';
  return `<div class="${cls}" ${o.attrs || ''} data-name="${esc(name)}">${costHtml(o.cost || c.cost, c.cost)}${cnt}<div class="art" style="background-image:url('img/art/${c.art}')"></div>${tag}<div class="nm">${esc(c.name)}</div><div class="ds">${esc(c.desc)}</div>${stats}</div>`;
}
const totalCost = c => c.cost.T + c.cost.W + c.cost.B + c.cost.D;

// ================= paczki =================
$$('[data-buy]').forEach(b => b.onclick = () => send({ t: 'buyPack', kind: b.dataset.buy }));
$$('[data-open]').forEach(b => b.onclick = () => send({ t: 'openPack', kind: b.dataset.open }));
function showPack(kind, names) {
  const before = S.me.collection;
  $('#pack-title').textContent = kind === 'leg' ? 'Legendarna paczka' : 'Zwykła paczka';
  const seen = {};
  $('#pack-cards').innerHTML = names.map((n, i) => {
    const c = S.byName[n];
    seen[n] = (seen[n] || 0) + 1;
    const isNew = !(before[n] > 0) && seen[n] === 1;
    return `<div class="flip" data-i="${i}"><div class="back r${c.rarity}"></div><div class="front">${cardHtml(n)}</div>${isNew ? '<div class="new-badge">NOWA</div>' : ''}</div>`;
  }).join('');
  $('#pack-overlay').classList.remove('hidden');
  $('#btn-pack-close').classList.add('hidden');
  $('#btn-reveal-all').classList.remove('hidden');
  const check = () => { if ($$('.flip:not(.open)').length === 0) { $('#btn-pack-close').classList.remove('hidden'); $('#btn-reveal-all').classList.add('hidden'); } };
  $$('.flip').forEach(f => f.onclick = () => { f.classList.add('open'); check(); });
  $('#btn-reveal-all').onclick = () => { $$('.flip').forEach((f, i) => setTimeout(() => { f.classList.add('open'); check(); }, i * 180)); };
}
$('#btn-pack-close').onclick = () => $('#pack-overlay').classList.add('hidden');

// ================= kolekcja i talie =================
['#f-search', '#f-type', '#f-rarity', '#f-city', '#f-owned'].forEach(s => $(s).addEventListener('input', renderCollection));

function filteredCards() {
  const q = $('#f-search').value.trim().toLowerCase();
  const type = $('#f-type').value, rar = $('#f-rarity').value, city = $('#f-city').value, owned = $('#f-owned').checked;
  return S.cards.filter(c => {
    if (q && !(c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))) return false;
    if (type && c.type !== type) return false;
    if (rar && String(c.rarity) !== rar) return false;
    if (city === 'N' && (c.cost.T + c.cost.W + c.cost.B) > 0) return false;
    if (city && city !== 'N' && !c.cost[city]) return false;
    if (owned && !(S.me.collection[c.name] > 0)) return false;
    return true;
  }).sort((a, b) => totalCost(a) - totalCost(b) || a.name.localeCompare(b.name, 'pl'));
}

function renderCollection() {
  if (!S.me) return;
  const coll = S.me.collection;
  const inDeck = S.edit ? countBy(S.edit.cards) : {};
  const list = filteredCards();
  const ownedKinds = S.cards.filter(c => coll[c.name] > 0).length;
  $('#coll-summary').textContent = `Masz ${ownedKinds}/${S.cards.length} różnych kart (${Object.values(coll).reduce((a, b) => a + b, 0)} łącznie).` + (S.edit ? ' Tryb edycji talii – kliknij kartę, żeby dodać.' : '');
  $('#coll-cards').innerHTML = list.map(c => {
    const have = coll[c.name] || 0;
    const left = have - (inDeck[c.name] || 0);
    const maxed = S.edit && (left <= 0 || (inDeck[c.name] || 0) >= (c.rarity === 1 ? 3 : 1));
    return cardHtml(c.name, { count: S.edit ? left : have, cls: (have ? '' : 'unowned') + (maxed && have ? ' maxed' : '') });
  }).join('');
  $$('#coll-cards .card').forEach(el => {
    el.onclick = () => addToDeck(el.dataset.name);
    attachPreview(el, el.dataset.name);
  });
  renderDeckPanel();
}

function renderDeckPanel() {
  const editing = !!S.edit;
  $('#deck-list-view').classList.toggle('hidden', editing);
  $('#deck-edit-view').classList.toggle('hidden', !editing);
  if (!editing) {
    $('#deck-list').innerHTML = S.me.decks.map(d => {
      const p = deckProblem(d);
      return `<div class="deck-item" data-deck="${d.id}"><b>${esc(d.name)}</b>${p ? `<span class="bad">${esc(p)}</span>` : '<span class="small gold-t">gotowa</span>'}</div>`;
    }).join('') || '<p class="muted small">Nie masz jeszcze talii.</p>';
    $$('[data-deck]').forEach(el => el.onclick = () => {
      const d = S.me.decks.find(x => x.id === el.dataset.deck);
      S.edit = { id: d.id, name: d.name, cards: d.cards.slice() }; renderCollection();
    });
    return;
  }
  const size = S.me.rules.deckSize;
  $('#deck-size').textContent = size;
  $('#deck-count').textContent = S.edit.cards.length;
  $('.deck-count').classList.toggle('ok', S.edit.cards.length === size);
  if (document.activeElement !== $('#deck-name')) $('#deck-name').value = S.edit.name;
  $('#btn-deck-delete').classList.toggle('hidden', !S.edit.id);
  const cnt = countBy(S.edit.cards);
  const rows = Object.keys(cnt).map(n => S.byName[n]).filter(Boolean).sort((a, b) => totalCost(a) - totalCost(b) || a.name.localeCompare(b.name, 'pl'));
  $('#deck-cards').innerHTML = rows.map(c => `<div class="deck-row r${c.rarity}" data-rm="${esc(c.name)}" style="--art:url('img/art/${c.art}')">${costHtml(c.cost).replace('class="cost"', 'class="c"')}<span class="n">${esc(c.name)}</span><span class="x">×${cnt[c.name]}</span></div>`).join('');
  const holes = size - S.edit.cards.length;
  if (holes > 0) $('#deck-cards').innerHTML = Array.from({ length: holes }, () => '<div class="deck-row hole"><span class="n">— puste miejsce —</span></div>').join('') + $('#deck-cards').innerHTML;
  $$('[data-rm]').forEach(el => { el.onclick = () => { const i = S.edit.cards.indexOf(el.dataset.rm); if (i >= 0) S.edit.cards.splice(i, 1); renderCollection(); }; attachPreview(el, el.dataset.rm); });
  // krzywa many
  const curve = [0, 0, 0, 0, 0, 0, 0];
  for (const n of S.edit.cards) curve[Math.min(6, totalCost(S.byName[n]))]++;
  const mx = Math.max(1, ...curve);
  $('#deck-curve').innerHTML = curve.map((v, i) => `<div style="height:${(v / mx) * 100}%" title="${v}"><span>${i === 6 ? '6+' : i}</span></div>`).join('');
}

function addToDeck(name) {
  if (!S.edit) { toast('Wybierz lub utwórz talię po prawej, aby dodawać karty.'); return; }
  const c = S.byName[name];
  const have = S.me.collection[name] || 0;
  const n = S.edit.cards.filter(x => x === name).length;
  const max = c.rarity === 1 ? 3 : 1;
  if (S.edit.cards.length >= S.me.rules.deckSize) return toast('Talia jest pełna.', true);
  if (n >= have) return toast(have ? 'Nie masz więcej kopii.' : 'Nie masz tej karty.', true);
  if (n >= max) return toast(`Maksymalnie ${max} ${max === 1 ? 'kopia' : 'kopie'} tej karty.`, true);
  S.edit.cards.push(name);
  renderCollection();
}

function closeEditor() { S.edit = null; renderCollection(); }
$('#btn-new-deck').onclick = () => { S.edit = { id: null, name: 'Nowa talia', cards: [] }; renderCollection(); };
$('#deck-name').oninput = e => { if (S.edit) S.edit.name = e.target.value; };
$('#btn-deck-cancel').onclick = closeEditor;
$('#btn-deck-clear').onclick = () => { S.edit.cards = []; renderCollection(); };
$('#btn-deck-save').onclick = () => send({ t: 'saveDeck', id: S.edit.id, name: S.edit.name, cards: S.edit.cards });
$('#btn-deck-delete').onclick = () => {
  const box = modal(`<h2>Usunąć talię „${esc(S.edit.name)}”?</h2><div class="row center"><button class="btn danger" id="del-yes">Usuń</button><button class="btn ghost" id="del-no">Anuluj</button></div>`);
  box.querySelector('#del-yes').onclick = () => { send({ t: 'deleteDeck', id: S.edit.id }); closeModal(); closeEditor(); };
  box.querySelector('#del-no').onclick = closeModal;
};
$('#btn-deck-auto').onclick = () => {
  // uzupełnia talię najlepszymi posiadanymi kartami (legendy/rzadkie najpierw, potem tańsze)
  const size = S.me.rules.deckSize;
  const pool = S.cards.filter(c => S.me.collection[c.name] > 0).sort((a, b) => b.rarity - a.rarity || totalCost(a) - totalCost(b));
  let added = true;
  while (S.edit.cards.length < size && added) {
    added = false;
    for (const c of pool) {
      if (S.edit.cards.length >= size) break;
      const n = S.edit.cards.filter(x => x === c.name).length;
      if (n < Math.min(S.me.collection[c.name], c.rarity === 1 ? 3 : 1)) { S.edit.cards.push(c.name); added = true; }
    }
  }
  if (S.edit.cards.length < size) toast('Za mało kart w kolekcji – otwórz więcej paczek.', true);
  renderCollection();
};

// ================= profil =================
function renderProfile() {
  const cur = typeof S.me.avatar === 'number' ? 'f' + S.me.avatar : S.me.avatar;
  $('#avatar-pick').innerHTML = '<h3 class="small muted">Portrety</h3><div class="av-grid faces">' +
    Array.from({ length: 9 }, (_, i) => `<button type="button" class="${cur === 'f' + (i + 1) ? 'sel' : ''}" data-av="f${i + 1}"><img src="img/face_${i + 1}.webp" alt=""></button>`).join('') +
    '</div><h3 class="small muted">Karty</h3><div class="av-grid">' + cardAvatarGrid(cur) + '</div>';
  $$('#avatar-pick [data-av]').forEach(b => b.onclick = () => send({ t: 'setAvatar', avatar: b.dataset.av }));
  const s = S.me.stats;
  $('#my-stats').innerHTML = `<p>Wygrane: <b>${s.wins}</b> · Przegrane: <b>${s.losses}</b> · Zdobyte bonusy: <b class="gold-t">${s.bonuses}</b></p><p>Pokonani w obecnej serii: <b>${S.me.defeated.length}/${S.me.rules.bonusDistinct}</b></p>`;
}
$('#pw-form').onsubmit = e => {
  e.preventDefault();
  const a = $('#pw-new').value, b = $('#pw-new2').value;
  if (a !== b) { $('#pw-msg').textContent = 'Nowe hasła nie są takie same.'; return; }
  $('#pw-msg').textContent = '';
  send({ t: 'changePassword', oldPassword: $('#pw-old').value, newPassword: a, token: S.token });
  e.target.reset();
};

// ================= rynek wymiany =================
const decksWith = name => S.me.decks.filter(d => d.cards.includes(name)).map(d => d.name);
function myFreeCopies(name) {
  const offered = S.market.offers.filter(o => o.userId === S.me.id && o.give === name).length;
  return (S.me.collection[name] || 0) - offered;
}
const RARITY = { 1: 'Zwykła', 2: 'Rzadka', 3: 'Legendarna' };
function miniCard(name, extra = '') { return `<div class="mini" data-name="${esc(name)}">${cardHtml(name)}${extra}</div>`; }

function renderMarket() {
  if (!S.me || $('#tab-market').classList.contains('hidden')) return;
  const own = S.cards.filter(c => myFreeCopies(c.name) > 0).sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name, 'pl'));
  if (S.mGive && myFreeCopies(S.mGive) <= 0) { S.mGive = null; S.mWant = null; }
  const give = S.mGive && S.byName[S.mGive];
  $('#m-give').innerHTML = own.length ? own.map(c => `<button type="button" class="pick r${c.rarity} ${S.mGive === c.name ? 'sel' : ''}" data-give="${esc(c.name)}"><img src="img/art/${c.art}" alt=""><span>${esc(c.name)}</span><i>×${myFreeCopies(c.name)}</i></button>`).join('') : '<p class="muted small">Nie masz wolnych kart do oddania.</p>';
  if (give) {
    const wants = S.cards.filter(c => c.rarity === give.rarity && c.name !== give.name).sort((a, b) => (S.me.collection[a.name] > 0) - (S.me.collection[b.name] > 0) || a.name.localeCompare(b.name, 'pl'));
    $('#m-want-label').textContent = `Chcę dostać (${RARITY[give.rarity].toLowerCase()}):`;
    $('#m-want').innerHTML = wants.map(c => `<button type="button" class="pick r${c.rarity} ${S.mWant === c.name ? 'sel' : ''} ${S.me.collection[c.name] > 0 ? 'have' : ''}" data-want="${esc(c.name)}"><img src="img/art/${c.art}" alt=""><span>${esc(c.name)}</span>${S.me.collection[c.name] > 0 ? `<i>masz ${S.me.collection[c.name]}</i>` : '<i class="new">nowa!</i>'}</button>`).join('');
  } else {
    $('#m-want-label').textContent = 'Chcę dostać:';
    $('#m-want').innerHTML = '<p class="muted small">Najpierw wybierz kartę, którą oddajesz.</p>';
  }
  // ostrzeżenie o taliach
  let warn = '';
  if (give) {
    const ds = decksWith(give.name);
    const left = (S.me.collection[give.name] || 0) - 1;
    if (ds.length && left < Math.max(...S.me.decks.map(d => d.cards.filter(x => x === give.name).length))) warn = `⚠ Używasz tej karty w taliach: <b>${ds.map(esc).join(', ')}</b>. Po wymianie zostanie tam puste miejsce do uzupełnienia.`;
  }
  $('#m-warn').innerHTML = warn;
  $('#m-post').disabled = !(S.mGive && S.mWant);
  $('#m-summary').innerHTML = S.mGive && S.mWant ? `Oddam <b>${esc(S.mGive)}</b> za <b>${esc(S.mWant)}</b>` : '';
  $$('#m-give [data-give]').forEach(b => { b.onclick = () => { S.mGive = b.dataset.give; S.mWant = null; renderMarket(); }; attachPreview(b, b.dataset.give); });
  $$('#m-want [data-want]').forEach(b => { b.onclick = () => { S.mWant = b.dataset.want; renderMarket(); }; attachPreview(b, b.dataset.want); });

  // lista ofert
  const onlyMine = $('#m-filter').value;
  let offers = S.market.offers.slice().sort((a, b) => b.at - a.at);
  const canTake = o => o.userId !== S.me.id && S.me.collection[o.want] > 0;
  if (onlyMine === 'can') offers = offers.filter(canTake);
  if (onlyMine === 'mine') offers = offers.filter(o => o.userId === S.me.id);
  if (onlyMine === 'new') offers = offers.filter(o => o.userId !== S.me.id && !(S.me.collection[o.give] > 0));
  $('#m-offers').innerHTML = offers.map(o => {
    const mine = o.userId === S.me.id;
    let btn;
    if (mine) btn = `<button class="btn ghost small" data-cancel-offer="${o.id}">Wycofaj</button>`;
    else if (canTake(o)) btn = `<button class="btn gold small" data-take="${o.id}">Wymień</button>`;
    else btn = `<span class="muted small">Nie masz: ${esc(o.want)}</span>`;
    return `<div class="offer ${mine ? 'mine' : ''} ${canTake(o) ? 'ok' : ''}">
      <div class="who">${avImg(o.avatar)}<b>${esc(o.username)}</b><span class="muted small">${RARITY[S.byName[o.give].rarity]}</span></div>
      <div class="swap"><div><div class="lbl">oddaje</div>${miniCard(o.give, !mine && !(S.me.collection[o.give] > 0) ? '<span class="tag-new">nie masz!</span>' : '')}</div><div class="arrow">⇄</div><div><div class="lbl">chce</div>${miniCard(o.want)}</div></div>
      <div class="act">${btn}</div></div>`;
  }).join('') || '<p class="muted">Brak ofert. Wystaw pierwszą!</p>';
  $$('#m-offers .mini').forEach(el => attachPreview(el, el.dataset.name));
  $$('[data-cancel-offer]').forEach(b => b.onclick = () => send({ t: 'marketCancel', id: b.dataset.cancelOffer }));
  $$('[data-take]').forEach(b => b.onclick = () => confirmTake(S.market.offers.find(o => o.id === b.dataset.take)));
  $('#m-trades').innerHTML = S.market.trades.map(t => `<li><b>${esc(t.maker)}</b> dał(a) ${esc(t.give)} ⇄ <b>${esc(t.taker)}</b> dał(a) ${esc(t.want)} <span class="muted small">${new Date(t.at).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></li>`).join('') || '<li class="muted">Jeszcze nikt się nie wymieniał.</li>';
}
function confirmTake(o) {
  if (!o) return;
  const ds = decksWith(o.want);
  const left = (S.me.collection[o.want] || 0) - 1;
  const hit = S.me.decks.filter(d => d.cards.filter(x => x === o.want).length > left).map(d => d.name);
  const box = modal(`<h2>Wymiana z ${esc(o.username)}</h2>
    <div class="swap center">${miniCard(o.want)}<div class="arrow">→</div>${miniCard(o.give)}</div>
    <p>Oddajesz <b>${esc(o.want)}</b>, dostajesz <b>${esc(o.give)}</b>.</p>
    ${hit.length ? `<p class="warn">⚠ Ta karta jest w taliach: <b>${hit.map(esc).join(', ')}</b> – zostanie w nich puste miejsce.</p>` : ''}
    <div class="row center"><button class="btn gold" id="tk-yes">Wymieniam</button><button class="btn ghost" id="tk-no">Anuluj</button></div>`);
  box.querySelector('#tk-yes').onclick = () => { send({ t: 'marketAccept', id: o.id }); closeModal(); };
  box.querySelector('#tk-no').onclick = closeModal;
}
$('#m-post').onclick = () => { send({ t: 'marketPost', give: S.mGive, want: S.mWant }); S.mWant = null; };
$('#m-filter').onchange = renderMarket;

// ================= panel admina =================
function renderAdmin(users) {
  $('#admin-body').innerHTML = users.map(u => `
    <tr data-id="${u.id}">
      <td class="who">${avImg(u.avatar)}<div><b>${esc(u.username)}</b><div class="small muted">${u.online ? '<span class="dot on"></span>online' : 'offline'} · ${u.stats.wins}W/${u.stats.losses}P · ${u.cards} kart</div></div></td>
      <td><div class="row"><input type="number" min="0" class="a-gold" value="${u.gold}"><button class="btn gold small a-set">Ustaw</button></div>
        <div class="row quick">${[10, 50, 100, 500, -100].map(v => `<button class="btn ghost small a-add" data-v="${v}">${v > 0 ? '+' : ''}${v}</button>`).join('')}</div></td>
      <td><div class="row"><input type="number" min="0" class="a-std" value="${u.packs.std}" title="zwykłe"><input type="number" min="0" class="a-leg" value="${u.packs.leg}" title="legendarne"><button class="btn small a-packs">Ustaw</button></div></td>
      <td><button class="btn danger small a-reset">Reset hasła</button></td>
    </tr>`).join('');
  $$('#admin-body tr').forEach(tr => {
    const id = tr.dataset.id, q = s => tr.querySelector(s);
    q('.a-set').onclick = () => send({ t: 'adminSetGold', id, gold: q('.a-gold').value });
    tr.querySelectorAll('.a-add').forEach(b => b.onclick = () => send({ t: 'adminAddGold', id, amount: +b.dataset.v }));
    q('.a-packs').onclick = () => send({ t: 'adminSetPacks', id, std: q('.a-std').value, leg: q('.a-leg').value });
    q('.a-reset').onclick = () => {
      const name = tr.querySelector('b').textContent;
      const box = modal(`<h2>Zresetować hasło ${esc(name)}?</h2><p class="muted">Nowe hasło będzie: <b>haslo</b></p><div class="row center"><button class="btn danger" id="rs-yes">Resetuj</button><button class="btn ghost" id="rs-no">Anuluj</button></div>`);
      box.querySelector('#rs-yes').onclick = () => { send({ t: 'adminResetPassword', id }); closeModal(); };
      box.querySelector('#rs-no').onclick = closeModal;
    };
  });
}
$('#btn-admin-refresh').onclick = () => send({ t: 'adminList' });

// ================= podgląd karty =================
function attachPreview(el, name) {
  if (TOUCH) return;
  el.addEventListener('mouseenter', () => {
    const p = $('#preview');
    p.innerHTML = cardHtml(name);
    const r = el.getBoundingClientRect();
    const w = 236, h = w * 1.4;
    let x = r.right + 12; if (x + w > innerWidth) x = r.left - w - 12;
    let y = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), innerHeight - h - 8);
    p.style.left = x + 'px'; p.style.top = y + 'px';
    p.classList.remove('hidden');
  });
  el.addEventListener('mouseleave', () => $('#preview').classList.add('hidden'));
}
function hidePreview() { $('#preview').classList.add('hidden'); }

// ================= WALKA =================
function act(action) { send({ t: 'act', action }); }

function onGame(v) {
  const first = !S.view || S.view.id !== v.id;
  S.prevView = first ? null : S.view;
  S.view = v;
  if (first) { S.sel = null; S.gameOverShown = false; $('#opp-left').classList.add('hidden'); closeModal(); }
  show('game');
  renderGame();
  playFx(v, S.prevView);
}

function heroHtml(p, mine, active) {
  return `${avImg(p.avatar)}<div class="nm"><span>${esc(p.name)}</span></div><div class="hp">${p.hp}</div>${p.spellPower ? `<div class="sp" title="Moc pieśni">✦+${p.spellPower}</div>` : ''}`;
}
function manaHtml(p, mine, canAdd) {
  return ['T', 'W', 'B'].map(c => {
    const m = p.mana[c];
    let orbs = '';
    for (let k = 0; k < 4; k++) {
      if (k < m.lvl) orbs += `<span class="orb ${k < m.lvl - m.used ? 'ok ' + c : 'used'}"></span>`;
      else if (k === m.lvl && m.prog > 0) orbs += `<span class="orb build" style="--p:${(m.prog / [1, 1, 2, 2][k]) * 100}%" title="w budowie ${m.prog}/${[1, 1, 2, 2][k]}"></span>`;
      else orbs += '<span class="orb"></span>';
    }
    const plus = mine && canAdd && m.lvl < 4 ? `<button class="plus" data-mana="${c}" title="Rozbuduj ${CITY[c]}">+</button>` : `<span class="tot">${m.lvl - m.used}/${m.lvl}</span>`;
    return `<div class="mana-col" title="${CITY[c]}"><span class="mana-ic ${c}"></span>${orbs}${plus}</div>`;
  }).join('');
}
function unitHtml(u, mine, v) {
  const c = S.byName[u.name];
  const cls = ['unit', 'r' + c.rarity];
  if (mine && v.myTurn && u.canAttack && !v.over) cls.push('ready');
  if (S.sel && S.sel.uid === u.uid) cls.push('sel');
  if (u.frozen) cls.push('frozen');
  if (!mine && S.sel) cls.push('target');
  const a = u.atk > u.baseAtk ? 'up' : u.atk < u.baseAtk ? 'down' : '';
  const h = u.hp > u.baseHp ? 'up' : u.hp < u.maxHp ? 'down' : '';
  const badges = [];
  if (u.turnsLeft != null) badges.push(`<span title="Zniknie za ${u.turnsLeft} tur(y)">⏳${u.turnsLeft}</span>`);
  if (c.spellPower) badges.push(`<span title="Moc pieśni">✦${c.spellPower}</span>`);
  if (c.passive === 'TwoAttacks') badges.push('<span title="Dwa ataki">⚔²</span>');
  return `<div class="${cls.join(' ')}" data-id="${u.uid}" data-name="${esc(u.name)}" style="background-image:url('img/art/${c.art}')"><div class="badges">${badges.join('')}</div><div class="stat a ${a}">${u.atk}</div><div class="stat h ${h}">${u.hp}</div></div>`;
}

function renderGame() {
  const v = S.view; if (!v) return;
  const me = v.me, op = v.opp;
  const canAct = v.myTurn && !v.over;
  $('#hero-opp').innerHTML = heroHtml(op, false);
  $('#hero-me').innerHTML = heroHtml(me, true);
  $('#hero-opp').classList.toggle('active-turn', !v.myTurn && !v.over);
  $('#hero-me').classList.toggle('active-turn', v.myTurn && !v.over);
  $('#hero-opp').classList.toggle('target', !!(S.sel && S.sel.kind === 'attacker'));
  $('#opp-pile').innerHTML = `<div>Talia: <b>${op.deckCount}</b></div><div>Ręka: <b>${op.handCount}</b></div><div title="${esc(op.grave.join(', '))}">Cmentarz: <b>${op.grave.length}</b></div>`;
  $('#me-pile').innerHTML = `<div>Talia: <b>${me.deckCount}</b></div><div title="${esc(me.grave.join(', '))}">Cmentarz: <b>${me.grave.length}</b></div>`;
  $('#mana-opp').innerHTML = manaHtml(op, false, false);
  $('#mana-me').innerHTML = manaHtml(me, true, canAct && !me.manaActionUsed);
  $('#opp-hand').innerHTML = '<div class="cardback"></div>'.repeat(op.handCount);
  $('#board-opp').innerHTML = op.board.map(u => unitHtml(u, false, v)).join('');
  $('#board-me').innerHTML = me.board.map(u => unitHtml(u, true, v)).join('');
  const n = me.hand.length;
  $('#hand-me').style.setProperty('--hm', n <= 5 ? '4px' : n <= 7 ? '-14px' : '-34px');
  $('#hand-me').innerHTML = me.hand.map(c => cardHtml(c.name, { cost: c.cost, cls: (c.playable ? 'playable' : '') + (S.sel && S.sel.uid === c.uid ? ' sel' : ''), attrs: `data-uid="${c.uid}"` })).join('');
  const tb = $('#turn-banner');
  tb.textContent = v.over ? 'KONIEC GRY' : v.myTurn ? 'TWOJA TURA' : `TURA: ${op.name}`;
  tb.classList.toggle('mine', v.myTurn && !v.over);
  const end = $('#btn-end');
  end.disabled = !canAct;
  end.classList.toggle('mine', canAct);
  end.textContent = canAct ? 'Koniec tury' : 'Tura przeciwnika';
  $('#log-body').innerHTML = v.log.map(l => `<div>${esc(l)}</div>`).join('');
  $('#log-body').scrollTop = 1e6;
  $('#btn-concede').disabled = v.over;

  // zdarzenia
  $$('#mana-me [data-mana]').forEach(b => b.onclick = e => { e.stopPropagation(); act({ type: 'mana', city: b.dataset.mana }); });
  $$('#hand-me .card').forEach(el => {
    attachPreview(el, el.dataset.name);
    el.onclick = e => { e.stopPropagation(); onHandClick(el.dataset.uid); };
  });
  $$('#board-me .unit').forEach(el => {
    attachPreview(el, el.dataset.name);
    el.onclick = e => { e.stopPropagation(); onMyUnitClick(el.dataset.id); };
  });
  $$('#board-opp .unit').forEach(el => {
    attachPreview(el, el.dataset.name);
    el.onclick = e => { e.stopPropagation(); onEnemyClick(el.dataset.id); };
  });
  $('#hero-opp').onclick = e => { e.stopPropagation(); onEnemyClick('hero'); };
  updateHint();
}

function updateHint() {
  const h = $('#hint');
  let t = '';
  if (S.sel && S.sel.kind === 'attacker') t = 'Wybierz cel ataku: wrogą jednostkę lub bohatera';
  else if (S.sel && S.sel.kind === 'spell') t = 'Wybierz wrogą jednostkę do zniszczenia';
  else if (S.sel && S.sel.kind === 'preview') t = 'Stuknij ponownie, aby zagrać';
  h.textContent = t; h.classList.toggle('show', !!t);
}

function onHandClick(uid) {
  const v = S.view; if (!v || v.over) return;
  const card = v.me.hand.find(c => c.uid === uid);
  const data = S.byName[card.name];
  if (TOUCH && !(S.sel && S.sel.uid === uid)) { S.sel = { kind: 'preview', uid }; showTouchPreview(card.name); renderGame(); return; }
  hidePreview();
  if (!v.myTurn) { toast('Poczekaj na swoją turę.'); S.sel = null; renderGame(); return; }
  if (!card.playable) { toast('Nie stać Cię na tę kartę – rozbuduj miasta (+).', true); S.sel = null; renderGame(); return; }
  if (data.target === 'enemyUnit' && v.opp.board.length) { S.sel = { kind: 'spell', uid }; renderGame(); return; }
  S.sel = null;
  act({ type: 'play', uid });
}
function onMyUnitClick(uid) {
  const v = S.view; if (!v || v.over) return;
  const u = v.me.board.find(x => x.uid === uid);
  if (TOUCH && !(S.sel && S.sel.uid === uid) && !(v.myTurn && u.canAttack)) { showTouchPreview(u.name); return; }
  if (!v.myTurn) return toast('Poczekaj na swoją turę.');
  if (!u.canAttack) return toast(u.frozen ? 'Ta jednostka jest zamrożona.' : 'Ta jednostka nie może teraz atakować.');
  S.sel = S.sel && S.sel.uid === uid ? null : { kind: 'attacker', uid };
  renderGame();
}
function onEnemyClick(target) {
  const v = S.view; if (!v) return;
  if (S.sel && S.sel.kind === 'attacker') { act({ type: 'attack', uid: S.sel.uid, target }); S.sel = null; renderGame(); return; }
  if (S.sel && S.sel.kind === 'spell' && target !== 'hero') { act({ type: 'play', uid: S.sel.uid, target }); S.sel = null; renderGame(); return; }
  if (TOUCH && target !== 'hero') { const u = v.opp.board.find(x => x.uid === target); if (u) showTouchPreview(u.name); }
}
function showTouchPreview(name) {
  const p = $('#preview');
  p.innerHTML = cardHtml(name);
  p.style.left = '50%'; p.style.top = '12%'; p.style.transform = 'translateX(-50%)';
  p.classList.remove('hidden');
  clearTimeout(showTouchPreview.t);
  showTouchPreview.t = setTimeout(hidePreview, 2500);
}
$('#scr-game').addEventListener('click', () => { if (S.sel) { S.sel = null; hidePreview(); renderGame(); } });
$('#btn-end').onclick = e => { e.stopPropagation(); S.sel = null; act({ type: 'end' }); };
$('#btn-concede').onclick = e => {
  e.stopPropagation();
  const box = modal('<h2>Poddać się?</h2><p class="muted">Przeciwnik dostanie zwycięstwo i złoto.</p><div class="row center"><button class="btn danger" id="cq-yes">Poddaję się</button><button class="btn ghost" id="cq-no">Gram dalej</button></div>');
  box.querySelector('#cq-yes').onclick = () => { act({ type: 'concede' }); closeModal(); };
  box.querySelector('#cq-no').onclick = closeModal;
};
$('#log').addEventListener('click', e => { if (innerWidth <= 1100 && e.target.closest('.log-head') && !e.target.closest('button')) $('#log').classList.toggle('collapsed'); });
if (innerWidth <= 1100) $('#log').classList.add('collapsed');

// efekty: liczby obrażeń, animacje wejścia, zagrana karta przeciwnika
function floatAt(el, text, cls) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'float ' + cls; f.textContent = text;
  f.style.left = (r.left + r.width / 2) + 'px'; f.style.top = (r.top + r.height / 3) + 'px';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1200);
  el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
}
function playFx(v, prev) {
  const myHeroId = 'hero' + v.mySeat, oppHeroId = 'hero' + (1 - v.mySeat);
  for (const f of v.fx || []) {
    const target = f.id === myHeroId ? $('#hero-me') : f.id === oppHeroId ? $('#hero-opp') : (f.id ? document.querySelector(`[data-id="${f.id}"]`) : null);
    if (f.type === 'dmg') floatAt(target, '-' + f.amount, 'dmg');
    if (f.type === 'heal' && f.amount > 0) floatAt(target, '+' + f.amount, 'heal');
    if (f.type === 'summon') { const el = document.querySelector(`[data-id="${f.uid}"]`); if (el) el.classList.add('enter'); }
    if (f.type === 'play' && f.by !== v.mySeat) showPlayed(f.name, v.opp.name);
  }
  if (prev) {
    const old = new Set(prev.me.hand.map(c => c.uid));
    $$('#hand-me .card').forEach(el => { if (!old.has(el.dataset.uid)) el.classList.add('enter'); });
    if (prev.myTurn !== v.myTurn && !v.over) { const tb = $('#turn-banner'); tb.classList.remove('flash'); void tb.offsetWidth; tb.classList.add('flash'); }
  }
}
function showPlayed(name, who) {
  const p = $('#played');
  p.innerHTML = `<div class="inner"><div class="lbl">${esc(who)} zagrywa</div>${cardHtml(name)}</div>`;
  p.classList.remove('hidden');
  clearTimeout(showPlayed.t);
  showPlayed.t = setTimeout(() => p.classList.add('hidden'), 1800);
}

function onGameOver(m) {
  $('#opp-left').classList.add('hidden');
  const win = m.result === 'win';
  const reason = m.reason === 'concede' ? (win ? `${m.opponent} się poddał(a).` : 'Poddałeś się.') : m.reason === 'forfeit' ? (win ? 'Walkower – przeciwnik opuścił grę.' : 'Przegrana walkowerem.') : '';
  let reward = '';
  if (win) {
    reward = `<p>Nagroda: <b class="gold-t">+${m.reward.gold} złota</b></p>`;
    if (m.reward.bonus) reward += `<p class="gold-t" style="font-size:20px"><b>BONUS +${m.reward.bonus} złota!</b><br><span class="small muted">Pokonałeś 5 różnych graczy – seria zaczyna się od nowa.</span></p>`;
    else reward += `<p class="small muted">Seria: pokonani ${S.me ? S.me.defeated.length : '?'}/5 różnych graczy</p>`;
  }
  setTimeout(() => {
    const box = modal(`<div class="big ${win ? 'win' : 'loss'}">${win ? 'ZWYCIĘSTWO!' : 'Porażka'}</div><p>${win ? 'Pokonałeś' : 'Przegrałeś z'} <b>${esc(m.opponent)}</b>. ${esc(reason)}</p>${reward}<button class="btn gold" id="go-lobby">Wróć do menu</button>`);
    box.querySelector('#go-lobby').onclick = () => { closeModal(); S.view = null; show('hub'); setTab('play'); };
  }, 900);
}

function onOpponentLeft(m) {
  const box = $('#opp-left');
  box.classList.remove('hidden');
  const btn = $('#btn-claim');
  const tick = () => {
    if (!S.view || S.view.over || box.classList.contains('hidden')) return;
    const left = Math.max(0, Math.ceil((m.at + m.waitMs - Date.now()) / 1000));
    $('#opp-left-text').textContent = left > 0 ? `Przeciwnik się rozłączył. Walkower możliwy za ${left}s…` : 'Przeciwnik nie wrócił.';
    btn.disabled = left > 0;
    if (left > 0) setTimeout(tick, 500);
  };
  tick();
}
$('#btn-claim').onclick = e => { e.stopPropagation(); send({ t: 'claimWin' }); };

// ================= start =================
renderLoginUsers();
loadAvatarCards();
connect();
