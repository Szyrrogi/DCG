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

// ================= dźwięki (syntezowane, bez plików) =================
const SFX = (() => {
  let ctx = null, master = null;
  let muted = store.get('dcg_mute') === '1';
  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  addEventListener('pointerdown', ensure, { passive: true });
  function tone(freq, dur, { type = 'sine', vol = 0.3, at = 0, slide = 0, attack = 0.005 } = {}) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, { vol = 0.3, at = 0, freq = 1200, q = 1, type = 'bandpass', sweep = 0 } = {}) {
    const t = ctx.currentTime + at;
    const len = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master); src.start(t);
  }
  const lib = {
    draw: () => noise(0.18, { freq: 900, sweep: 3, vol: 0.18, q: 0.8 }),
    card: () => { tone(140, 0.18, { type: 'triangle', vol: 0.35, slide: 0.5 }); noise(0.06, { freq: 3000, vol: 0.12 }); },
    hit: () => { noise(0.22, { freq: 600, sweep: 0.3, vol: 0.45, q: 0.7, type: 'lowpass' }); tone(110, 0.25, { type: 'square', vol: 0.15, slide: 0.4 }); },
    bighit: () => { noise(0.4, { freq: 400, sweep: 0.2, vol: 0.6, type: 'lowpass' }); tone(70, 0.45, { type: 'sawtooth', vol: 0.2, slide: 0.5 }); },
    die: () => { tone(330, 0.35, { type: 'sawtooth', vol: 0.12, slide: 0.25 }); noise(0.3, { freq: 2000, sweep: 0.2, vol: 0.2 }); },
    spell: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, { vol: 0.12, at: i * 0.05 })),
    heal: () => [392, 523, 659].forEach((f, i) => tone(f, 0.35, { vol: 0.12, at: i * 0.07 })),
    mana: () => { tone(880, 0.25, { vol: 0.12 }); tone(1320, 0.3, { vol: 0.08, at: 0.05 }); },
    freeze: () => { [1568, 2093, 2637].forEach((f, i) => tone(f, 0.4, { vol: 0.05, at: i * 0.04 })); noise(0.4, { freq: 6000, vol: 0.06 }); },
    turn: () => { tone(392, 0.25, { type: 'triangle', vol: 0.2 }); tone(523, 0.45, { type: 'triangle', vol: 0.22, at: 0.16 }); },
    win: () => [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, i === 5 ? 0.7 : 0.2, { type: 'triangle', vol: 0.2, at: i * 0.12 })),
    lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, 0.45, { type: 'triangle', vol: 0.16, at: i * 0.22 })),
    coin: () => [1318, 1760].forEach((f, i) => tone(f, 0.12, { type: 'square', vol: 0.05, at: i * 0.07 })),
    click: () => tone(1200, 0.04, { vol: 0.05 }),
    flip: () => noise(0.12, { freq: 2500, vol: 0.12 }),
    rare: () => [659, 988].forEach((f, i) => tone(f, 0.4, { vol: 0.12, at: i * 0.08 })),
    legend: () => { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.9, { vol: 0.1, at: i * 0.06 })); noise(0.8, { freq: 5000, vol: 0.08 }); },
    craft: () => { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.35, { vol: 0.1, at: i * 0.06 })); noise(0.5, { freq: 7000, vol: 0.05 }); },
    dust: () => { noise(0.35, { freq: 3000, sweep: 0.3, vol: 0.2 }); tone(220, 0.2, { type: 'triangle', vol: 0.1, slide: 0.5 }); },
    error: () => tone(160, 0.15, { type: 'square', vol: 0.06 }),
  };
  return {
    play(name) { if (muted) return; try { if (ensure() && lib[name]) lib[name](); } catch { /* brak dźwięku */ } },
    get muted() { return muted; },
    toggle() { muted = !muted; store.set('dcg_mute', muted ? '1' : '0'); return muted; },
  };
})();
function updateMuteButtons() { $$('.btn-mute').forEach(b => { b.textContent = SFX.muted ? '🔇' : '🔊'; b.title = SFX.muted ? 'Włącz dźwięk' : 'Wycisz'; }); }
document.addEventListener('click', e => { if (e.target.closest('.btn-mute')) { e.stopPropagation(); SFX.toggle(); updateMuteButtons(); SFX.play('click'); } }, true);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const center = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
// wybuch cząsteczek w punkcie
function burst(x, y, { n = 14, color = '#f2c14e', spread = 70, size = 7 } = {}) {
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'particle';
    const ang = Math.random() * Math.PI * 2, dist = spread * (0.5 + Math.random());
    d.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${color}`;
    document.body.appendChild(d);
    d.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(.2)`, opacity: 0 }], { duration: 500 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => d.remove();
  }
}
// płynne liczenie liczby w elemencie
function tweenNumber(el, to) {
  const from = parseInt(el.textContent, 10);
  if (!Number.isFinite(from) || from === to) { el.textContent = to; return; }
  const t0 = performance.now(), dur = 600;
  const step = now => { const k = Math.min(1, (now - t0) / dur); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  el.parentElement.classList.remove('bump'); void el.offsetWidth; el.parentElement.classList.add('bump');
}

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
    case 'crafted': onCrafted(m); break;
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
    case 'spectateEnd': onSpectateEnd(m); break;
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
  if (err) SFX.play('error');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), Math.max(err ? 4200 : 3000, msg.length * 60));
}
function modal(html) { $('#modal-box').innerHTML = html; $('#modal').classList.remove('hidden'); return $('#modal-box'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-box').classList.remove('pay-box'); S.craftOpen = null; }

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
  const prevGold = S.me && S.me.gold;
  S.me = me;
  if (prevGold != null && me.gold > prevGold) SFX.play('coin');
  tweenNumber($('#me-gold'), me.gold);
  tweenNumber($('#me-dust'), me.dust || 0);
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
  if (S.craftOpen) openCraft(S.craftOpen, true);
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
    else if (p.inGame) btn = `<button class="btn small" data-watch="${p.id}" title="${p.opponent ? 'gra z ' + esc(p.opponent) : ''}">👀 Oglądaj</button>`;
    else btn = `<button class="btn small" data-challenge="${p.id}" ${!p.online || myOut ? 'disabled' : ''}>Wyzwij</button>`;
    if (p.inGame && p.opponent) status += ` z ${esc(p.opponent)}${p.watchers ? ` · 👀 ${p.watchers}` : ''}`;
    const beaten = S.me.defeated.includes(p.id) ? ' <span class="gold-t small" title="Pokonany w tej serii">✔</span>' : '';
    return `<div class="player-row ${isMe ? 'me' : ''}">${avImg(p.avatar)}<div class="info"><div class="name">${esc(p.username)}${beaten}</div><div class="small muted">${status} · ${p.stats.wins}W / ${p.stats.losses}P</div></div>${btn}</div>`;
  }).join('');
  $$('[data-challenge]').forEach(b => b.onclick = () => {
    const deckId = $('#play-deck').value;
    if (!deckId) return toast('Najpierw wybierz gotową talię.', true);
    send({ t: 'challenge', to: b.dataset.challenge, deckId });
  });
  $$('[data-cancel]').forEach(b => b.onclick = () => send({ t: 'cancelChallenge' }));
  $$('[data-watch]').forEach(b => b.onclick = () => send({ t: 'spectate', userId: b.dataset.watch }));
  $$('[data-accept]').forEach(b => b.onclick = () => { const p = players.find(x => x.id === b.dataset.accept); showChallenge(p.id, p.username); });

  // bonus
  const others = players.filter(p => p.id !== S.me.id);
  $('#bonus-track').innerHTML = others.map(p => {
    const d = S.me.defeated.includes(p.id);
    return `<div class="slot ${d ? 'done' : ''}">${avImg(p.avatar)}<div>${esc(p.username)}</div><div>${d ? '✔ pokonany' : '—'}</div></div>`;
  }).join('') + `<div class="slot" style="align-self:center;font-size:14px"><b class="gold-t">${S.me.defeated.length}/${S.me.rules.bonusDistinct}</b></div>`;
  const co = (S.me.rules.cashOut || {})[S.me.defeated.length];
  $('#cashout').innerHTML = co
    ? `<button class="btn gold" id="btn-cashout">💰 Wypłać teraz ${co} złota</button><span class="muted small">albo graj dalej po pełne ${S.me.rules.bonusGold}. Wypłata resetuje serię.</span>`
    : `<span class="muted small">Wcześniejsza wypłata: przy 3/5 – ${(S.me.rules.cashOut || {})[3] || 30} złota, przy 4/5 – ${(S.me.rules.cashOut || {})[4] || 60} złota.</span>`;
  const cb = $('#btn-cashout');
  if (cb) cb.onclick = () => {
    const box = modal(`<h2>Wypłacić ${co} złota?</h2><p class="muted">Seria pokonanych (${S.me.defeated.length}/5) zacznie się od nowa.</p><div class="row center"><button class="btn gold" id="co-yes">Wypłać</button><button class="btn ghost" id="co-no">Gram dalej</button></div>`);
    box.querySelector('#co-yes').onclick = () => { send({ t: 'cashOut' }); closeModal(); };
    box.querySelector('#co-no').onclick = closeModal;
  };

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
  return `<div class="${cls}" ${o.attrs || ''} data-name="${esc(name)}">${costHtml(o.cost || c.cost, c.cost)}${cnt}<div class="art" style="background-image:url('img/art/${c.art}')"></div>${tag}<div class="nm">${esc(c.name)}</div><div class="ds">${kw(c.desc)}</div>${stats}</div>`;
}
const totalCost = c => c.cost.T + c.cost.W + c.cost.B + c.cost.D;
// kolejność „po koszcie”: grupy wg many miast (do 2, potem 3, potem 4), w grupie łączny koszt,
// a przy równym – mana miast jest „droższa” od dowolnej
const cityCost = c => c.cost.T + c.cost.W + c.cost.B;
const cityGroup = c => Math.max(2, cityCost(c));
const byCost = (a, b) => cityGroup(a) - cityGroup(b) || totalCost(a) - totalCost(b) || cityCost(a) - cityCost(b) || a.name.localeCompare(b.name, 'pl');
// pogrubienie słów kluczowych w opisach kart
const KEYWORDS = /(Okrzyk Bojowy|Szarża|Prowokacj\p{L}*|nie może otrzymywać obrażeń|zużytą kulę|Położenie|Moc pie[sś]ni(?: \+ ?\d+)?|Zamr[oó]ź\p{L}*|Wskrze[sś]\p{L}*|Odrzu[cć]\p{L}*|odrzucone|Dobierz|Przyzwij|Przywołaj|Zagraj|Zniszcz\p{L}*|Cofnij|cofnięcie|Zwiększ|piosen\p{L}*|informatyk\p{L}*|dziewczyn\p{L}*|Lewca?|dwa razy|Na koniec Twojej tury|podwójny atak|Po (?:dwóch|trzech) turach zniknij|Na początku Twojej tury|wybran\p{L}*|\d+%|\+\d+\/\+\d+|\+\d+ (?:ataku|zdrowia|HP)|\d+ obraże\p{L}*|\d+ zdrowia)/giu;
const kw = text => esc(text).replace(KEYWORDS, '<b>$1</b>');

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
    return `<div class="flip" data-i="${i}" data-r="${c.rarity}"><div class="back r${c.rarity}"></div><div class="front">${cardHtml(n)}</div>${isNew ? '<div class="new-badge">NOWA</div>' : ''}</div>`;
  }).join('');
  $('#pack-overlay').classList.remove('hidden');
  $('#btn-pack-close').classList.add('hidden');
  $('#btn-reveal-all').classList.remove('hidden');
  const check = () => { if ($$('.flip:not(.open)').length === 0) { $('#btn-pack-close').classList.remove('hidden'); $('#btn-reveal-all').classList.add('hidden'); } };
  const open = f => {
    if (f.classList.contains('open')) return;
    f.classList.add('open'); check();
    const r = +f.dataset.r;
    SFX.play(r === 3 ? 'legend' : r === 2 ? 'rare' : 'flip');
    if (r >= 2) { const c = center(f); burst(c.x, c.y, { n: r === 3 ? 40 : 18, color: r === 3 ? '#ffb400' : '#8a8fff', spread: r === 3 ? 160 : 90 }); }
    if (r === 3) { $('#pack-overlay').classList.remove('flash'); void $('#pack-overlay').offsetWidth; $('#pack-overlay').classList.add('flash'); }
  };
  $$('.flip').forEach(f => f.onclick = () => open(f));
  $('#btn-reveal-all').onclick = () => { $$('.flip:not(.open)').forEach((f, i) => setTimeout(() => open(f), i * 220)); };
  SFX.play('draw');
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
  }).sort(byCost);
}

function renderCollection() {
  if (!S.me) return;
  const coll = S.me.collection;
  const inDeck = S.edit ? countBy(S.edit.cards) : {};
  const list = filteredCards();
  const ownedKinds = S.cards.filter(c => coll[c.name] > 0).length;
  $('#coll-summary').textContent = `Masz ${ownedKinds}/${S.cards.length} różnych kart (${Object.values(coll).reduce((a, b) => a + b, 0)} łącznie).` + (S.edit ? ' Tryb edycji talii – kliknij kartę, żeby dodać.' : ' Kliknij kartę, żeby ją wytworzyć lub rozbić na pył.');
  $('#coll-cards').innerHTML = list.map(c => {
    const have = coll[c.name] || 0;
    const left = have - (inDeck[c.name] || 0);
    const maxed = S.edit && (left <= 0 || (inDeck[c.name] || 0) >= (c.rarity === 1 ? 3 : 1));
    return cardHtml(c.name, { count: S.edit ? left : have, cls: (have ? '' : 'unowned') + (maxed && have ? ' maxed' : '') });
  }).join('');
  $$('#coll-cards .card').forEach(el => {
    el.onclick = () => S.edit ? addToDeck(el.dataset.name) : openCraft(el.dataset.name);
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
  const rows = Object.keys(cnt).map(n => S.byName[n]).filter(Boolean).sort(byCost);
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

// ================= wytwarzanie (pył) =================
const RAR_NAME = { 1: 'zwykła', 2: 'rzadka', 3: 'legendarna' };
function freeCopies(name) { return (S.me.collection[name] || 0) - S.market.offers.filter(o => o.userId === S.me.id && o.give === name).length; }
function deckLossWarning(name, k) {
  const left = (S.me.collection[name] || 0) - k;
  const hit = S.me.decks.filter(d => d.cards.filter(x => x === name).length > left).map(d => d.name);
  return hit.length ? `<p class="warn">⚠ Karta jest w taliach: <b>${hit.map(esc).join(', ')}</b> – zostanie w nich puste miejsce.</p>` : '';
}
function openCraft(name, refresh = false) {
  if (refresh && $('#modal').classList.contains('hidden')) { S.craftOpen = null; return; }
  const c = S.byName[name]; if (!c) return;
  S.craftOpen = name;
  const D = S.me.rules.dust, have = S.me.collection[name] || 0, free = freeCopies(name);
  const gain = D.disenchant[c.rarity], cost = D.craft[c.rarity];
  const box = modal(`
    <div class="craft">
      <div class="craft-card">${cardHtml(name)}</div>
      <div class="craft-info">
        <h2>${esc(c.name)}</h2>
        <p class="muted small">Karta ${RAR_NAME[c.rarity]} · masz <b>${have}</b>${free < have ? ` (wolnych ${free}, reszta na rynku)` : ''}</p>
        <p class="dust-line"><i class="dust"></i> Twój pył: <b>${S.me.dust}</b></p>
        <button class="btn gold wide" id="cr-make" ${S.me.dust < cost ? 'disabled' : ''}>⚒ Wytwórz za ${cost} pyłu</button>
        <button class="btn wide" id="cr-break" ${free <= 0 ? 'disabled' : ''}>💥 Rozbij na ${gain} pyłu</button>
        ${free > 0 ? deckLossWarning(name, 1) : ''}
        <button class="btn ghost wide" id="cr-close">Zamknij</button>
      </div>
    </div>`);
  box.querySelector('#cr-make').onclick = () => send({ t: 'craft', name });
  box.querySelector('#cr-break').onclick = () => send({ t: 'disenchant', cards: { [name]: 1 } });
  box.querySelector('#cr-close').onclick = () => { S.craftOpen = null; closeModal(); };
}
function extraCopies() {
  // kopie ponad limit talii (3 zwykłe / 1 rzadka i legendarna), które nie są na rynku
  const out = {};
  for (const c of S.cards) {
    const extra = Math.min((S.me.collection[c.name] || 0) - (c.rarity === 1 ? 3 : 1), freeCopies(c.name));
    if (extra > 0) out[c.name] = extra;
  }
  return out;
}
$('#btn-dust-extra').onclick = () => {
  const ex = extraCopies();
  const names = Object.keys(ex);
  if (!names.length) return toast('Nie masz nadmiarowych kart – wszystko mieści się w limitach talii.');
  const total = names.reduce((s, n) => s + ex[n] * S.me.rules.dust.disenchant[S.byName[n].rarity], 0);
  const box = modal(`<h2>Rozbić nadmiarowe karty?</h2>
    <p class="muted small">Zostaje Ci po 3 kopie zwykłych i po 1 rzadkiej/legendarnej – tyle, ile można mieć w talii.</p>
    <div class="extra-list">${names.map(n => `<div><span>${esc(n)}</span><b>×${ex[n]}</b></div>`).join('')}</div>
    <p class="dust-line"><i class="dust"></i> Dostaniesz <b>${total}</b> pyłu</p>
    <div class="row center"><button class="btn gold" id="dx-yes">Rozbij</button><button class="btn ghost" id="dx-no">Anuluj</button></div>`);
  box.querySelector('#dx-yes').onclick = () => { send({ t: 'disenchant', cards: ex }); closeModal(); };
  box.querySelector('#dx-no').onclick = closeModal;
};
function onCrafted(m) {
  if (m.kind === 'craft') {
    SFX.play('craft');
    const el = $('.craft-card .card');
    if (el) { const c = center(el); burst(c.x, c.y, { n: 30, color: '#9be7ff', spread: 140 }); el.animate([{ filter: 'brightness(3)', transform: 'scale(1.1)' }, { filter: 'brightness(1)', transform: 'scale(1)' }], { duration: 600, easing: 'ease-out' }); }
    toast(`Wytworzono: ${m.name} (−${m.dust} pyłu)`);
  } else {
    SFX.play('dust');
    const el = $('.craft-card .card');
    if (el) { const c = center(el); burst(c.x, c.y, { n: 24, color: '#c9b6ff', spread: 120, size: 5 }); }
    toast(`Rozbito ${m.count} ${m.count === 1 ? 'kartę' : 'kart'}: +${m.dust} pyłu`);
  }
}

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
        <div class="row quick"><span class="small muted">pył</span><input type="number" min="0" class="a-dust" value="${u.dust || 0}"><button class="btn small a-dust-set">Ustaw</button></div>
        <div class="row quick">${[10, 50, 100, 500, -100].map(v => `<button class="btn ghost small a-add" data-v="${v}">${v > 0 ? '+' : ''}${v}</button>`).join('')}</div></td>
      <td><div class="row"><input type="number" min="0" class="a-std" value="${u.packs.std}" title="zwykłe"><input type="number" min="0" class="a-leg" value="${u.packs.leg}" title="legendarne"><button class="btn small a-packs">Ustaw</button></div></td>
      <td><button class="btn danger small a-reset">Reset hasła</button></td>
    </tr>`).join('');
  $$('#admin-body tr').forEach(tr => {
    const id = tr.dataset.id, q = s => tr.querySelector(s);
    q('.a-set').onclick = () => send({ t: 'adminSetGold', id, gold: q('.a-gold').value });
    q('.a-dust-set').onclick = () => send({ t: 'adminSetDust', id, dust: q('.a-dust').value });
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

S.queue = Promise.resolve(); S.queued = 0;
function onGame(v) {
  S.queued++;
  S.queue = S.queue.then(() => processView(v)).catch(e => console.error(e)).finally(() => S.queued--);
}
async function processView(v) {
  const first = !S.view || S.view.id !== v.id;
  const prev = first ? null : S.view;
  if (first) { S.sel = null; S.mullSel = new Set(); S.mullSent = false; S.gameOverShown = false; $('#opp-left').classList.add('hidden'); closeModal(); $('.battle').classList.remove('defeat'); }
  show('game');
  const fast = S.queued > 2;           // zaległości – pomijamy długie animacje
  if (prev && !fast) await animateBefore(v, prev);
  S.prevView = prev; S.view = v;
  renderGame();
  animateAfter(v, prev, first, fast);
  if (!fast) await sleep(120);
}

// --- animacje na starym widoku (zanim jednostki znikną) ---
function fxTarget(v, id) {
  if (id === 'hero' + v.mySeat) return $('#hero-me');
  if (id === 'hero' + (1 - v.mySeat)) return $('#hero-opp');
  return id ? document.querySelector(`.board [data-id="${id}"]`) : null;
}
async function animateBefore(v, prev) {
  const fx = v.fx || [];
  // moja zagrana karta leci z ręki na stół
  for (const f of fx.filter(f => f.type === 'play' && f.by === v.mySeat)) {
    const card = prev.me.hand.find(c => c.name === f.name && !v.me.hand.some(h => h.uid === c.uid));
    const el = card && document.querySelector(`#hand-me [data-uid="${card.uid}"]`);
    if (!el) continue;
    const from = center(el), to = center($('#board-me'));
    const isSpell = S.byName[f.name].type === 'spell';
    SFX.play(isSpell ? 'spell' : 'card');
    await el.animate([{ transform: 'none' }, { transform: `translate(${to.x - from.x}px, ${to.y - from.y - (isSpell ? 60 : 0)}px) scale(${isSpell ? 1.3 : 0.6})`, opacity: isSpell ? 0 : 0.3 }], { duration: 260, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }).finished;
    if (isSpell) burst(to.x, to.y - 60, { n: 22, color: '#b9a0ff', spread: 120 });
  }
  // natarcia
  const attacks = fx.filter(f => f.type === 'attack');
  for (const f of attacks) {
    const a = document.querySelector(`.board [data-id="${f.from}"]`), t = fxTarget(v, f.to);
    if (!a || !t) continue;
    const p = center(a), q = center(t);
    a.style.zIndex = 10;
    const anim = a.animate([
      { transform: 'none' },
      { transform: `translate(${(p.x - q.x) * 0.12}px, ${(p.y - q.y) * 0.12}px) scale(1.08)`, offset: 0.25 },
      { transform: `translate(${(q.x - p.x) * 0.82}px, ${(q.y - p.y) * 0.82}px) scale(1.12)`, offset: 0.55 },
      { transform: 'none' },
    ], { duration: 460, easing: 'ease-in-out' });
    await sleep(250);
    const big = fx.some(x => x.type === 'dmg' && x.id === f.to && x.amount >= 5);
    SFX.play(big ? 'bighit' : 'hit');
    burst(q.x, q.y, { n: 10, color: '#ffd27a', spread: 50, size: 5 });
    if (big) shake();
    await anim.finished; a.style.zIndex = '';
  }
  // obrażenia i śmierć jednostek, które za chwilę znikną
  const dying = fx.filter(f => f.type === 'die').map(f => document.querySelector(`.board [data-id="${f.id}"]`)).filter(Boolean);
  if (!dying.length) return;
  for (const f of fx.filter(f => f.type === 'dmg')) { const el = fxTarget(v, f.id); if (el && dying.includes(el)) floatAt(el, '-' + f.amount, 'dmg'); }
  SFX.play('die');
  for (const el of dying) {
    const c = center(el);
    el.classList.add('dying');
    setTimeout(() => burst(c.x, c.y, { n: 16, color: '#9b8b7a', spread: 80, size: 6 }), 200);
  }
  await sleep(430);
}

function shake() {
  const b = $('.battle');
  b.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-8px,4px)' }, { transform: 'translate(7px,-5px)' }, { transform: 'translate(-5px,-3px)' }, { transform: 'translate(3px,2px)' }, { transform: 'translate(0,0)' }], { duration: 380 });
}

// --- animacje na nowym widoku ---
function animateAfter(v, prev, first, fast) {
  const fx = v.fx || [];
  const shown = new Set();
  for (const f of fx) {
    const el = fxTarget(v, f.id);
    if (f.type === 'dmg' && el && el.isConnected) {
      if (!shown.has(f.id + ':' + fx.indexOf(f))) floatAt(el, '-' + f.amount, 'dmg');
      if (el.classList.contains('hero')) { el.classList.remove('hurt'); void el.offsetWidth; el.classList.add('hurt'); if (f.amount >= 5 && !fx.some(x => x.type === 'attack')) { shake(); SFX.play('bighit'); } }
    }
    if (f.type === 'heal' && el) { if (f.amount > 0) floatAt(el, '+' + f.amount, 'heal'); el.classList.remove('healed'); void el.offsetWidth; el.classList.add('healed'); SFX.play('heal'); }
    if (f.type === 'summon') { const u = document.querySelector(`.board [data-id="${f.uid}"]`); if (u) { u.classList.add('enter'); if (!fx.some(x => x.type === 'play' && x.by === v.mySeat)) SFX.play('card'); } }
    if (f.type === 'freeze' && el) { el.classList.add('freezing'); }
    if (f.type === 'immune' && el) { floatAt(el, '🛡', 'heal'); }
    if (f.type === 'buff' && el) { el.classList.remove('buffed'); void el.offsetWidth; el.classList.add('buffed'); }
    if (f.type === 'play' && f.by !== v.mySeat) { showPlayed(f.name, v.opp.name); SFX.play(S.byName[f.name].type === 'spell' ? 'spell' : 'card'); }
    if (f.type === 'burn' && f.by === v.mySeat) toast(`Pełna ręka – ${f.name} spala się!`, true);
  }
  if (fx.some(f => f.type === 'freeze')) SFX.play('freeze');

  // dobieranie kart
  const oldUids = new Set(prev ? prev.me.hand.map(c => c.uid) : []);
  const newCards = $$('#hand-me .card').filter(el => !oldUids.has(el.dataset.uid));
  newCards.forEach((el, i) => animateDraw(el, fast ? 0 : i * 150));
  const oppDraws = fx.filter(f => f.type === 'draw' && f.by !== v.mySeat).length;
  for (let i = 0; i < Math.min(oppDraws, 6); i++) setTimeout(() => animateOppDraw(), fast ? 0 : i * 150);

  // nowa kula many
  if (prev) for (const c of ['T', 'W', 'B']) {
    if (v.me.mana[c].lvl > prev.me.mana[c].lvl) { const orbs = $$(`#mana-me .mana-col[data-c="${c}"] .orb.ok`); const o = orbs[orbs.length - 1]; if (o) o.classList.add('pop'); SFX.play('mana'); }
  }

  // początek tury
  if (v.phase === 'play' && ((prev && (prev.myTurn !== v.myTurn || prev.phase !== v.phase)) || first)) {
    if (!v.over && !v.spectator) turnBanner(v.myTurn ? 'TWOJA TURA' : `Tura: ${v.opp.name}`, v.myTurn);
  }
  if (v.spectator && v.phase === 'play' && !v.over && (first || !prev || prev.currentSeat !== v.currentSeat || prev.phase !== v.phase)) turnBanner(`Tura: ${v.currentName}`, false);
}

function animateDraw(el, delay) {
  const pile = $('#me-pile .deckpile') || $('#hero-me');
  const from = center(pile), r = el.getBoundingClientRect();
  const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  el.classList.add('drawing');
  el.style.opacity = '0';
  setTimeout(() => {
    el.style.opacity = '';
    SFX.play('draw');
    const dx = from.x - to.x, dy = from.y - to.y;
    const a = el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.3, .3) rotate(-12deg)` },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 120}px) scale(0, 1.05) rotate(-4deg)`, offset: 0.45 },
      { transform: `translate(${dx * 0.2}px, ${-150}px) scale(1.25) rotate(0deg)`, offset: 0.7 },
      { transform: 'none' },
    ], { duration: 720, easing: 'cubic-bezier(.25,.8,.35,1)' });
    const back = el.querySelector('.cb') || el.appendChild(Object.assign(document.createElement('div'), { className: 'cb' }));
    back.animate([{ opacity: 1 }, { opacity: 1, offset: 0.44 }, { opacity: 0, offset: 0.46 }, { opacity: 0 }], { duration: 720 });
    a.onfinish = () => { el.classList.remove('drawing'); back.remove(); };
  }, delay);
}
function animateOppDraw() {
  const pile = $('#opp-pile .deckpile') || $('#hero-opp');
  let target = $('#opp-hand .cardback:last-child');
  if (!target || !target.offsetParent) target = $('#hero-opp');
  const from = center(pile), to = center(target);
  const d = document.createElement('div');
  d.className = 'cardback flying';
  d.style.left = from.x + 'px'; d.style.top = from.y + 'px';
  document.body.appendChild(d);
  SFX.play('draw');
  d.animate([{ transform: 'translate(-50%,-50%) scale(.6) rotate(-20deg)' }, { transform: `translate(calc(-50% + ${(to.x - from.x) / 2}px), calc(-50% + ${(to.y - from.y) / 2 + 40}px)) scale(1.4) rotate(10deg)` }, { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y}px)) scale(1)` }], { duration: 520, easing: 'ease-out' }).onfinish = () => d.remove();
}
function turnBanner(text, mine) {
  const b = $('#turn-splash');
  b.textContent = text;
  b.className = 'turn-splash ' + (mine ? 'mine' : 'theirs');
  void b.offsetWidth; b.classList.add('show');
  if (mine) SFX.play('turn');
}

// czy dany cel (jednostka przeciwnika albo 'hero') można teraz kliknąć
function isValidTarget(u, v) {
  if (!S.sel) return false;
  if (S.sel.kind === 'attacker') {
    const taunts = v.opp.board.filter(x => x.taunt);
    if (!taunts.length) return true;
    return u !== 'hero' && u.taunt;
  }
  if (S.sel.kind === 'spell') return u !== 'hero' || S.sel.any;
  return false;
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
    return `<div class="mana-col" data-c="${c}" title="${CITY[c]}"><span class="mana-ic ${c}"></span>${orbs}${plus}</div>`;
  }).join('');
}
function unitHtml(u, mine, v) {
  const c = S.byName[u.name];
  const cls = ['unit', 'r' + c.rarity];
  if (mine && v.myTurn && u.canAttack && !v.over) cls.push('ready');
  if (S.sel && S.sel.uid === u.uid) cls.push('sel');
  if (u.frozen) cls.push('frozen');
  if (!mine && isValidTarget(u, v)) cls.push('target');
  if (u.taunt) cls.push('taunt');
  const a = u.atk > u.baseAtk ? 'up' : u.atk < u.baseAtk ? 'down' : '';
  const h = u.hp > u.baseHp ? 'up' : u.hp < u.maxHp ? 'down' : '';
  const badges = [];
  if (u.turnsLeft != null) badges.push(`<span title="Zniknie za ${u.turnsLeft} tur(y)">⏳${u.turnsLeft}</span>`);
  if (c.spellPower) badges.push(`<span title="Moc pieśni">✦${c.spellPower}</span>`);
  if (c.passive === 'TwoAttacks') badges.push('<span title="Dwa ataki">⚔²</span>');
  if (c.passive === 'HeroImmune') badges.push('<span title="Bohater nie otrzymuje obrażeń">🛡♥</span>');
  return `<div class="${cls.join(' ')}" data-id="${u.uid}" data-name="${esc(u.name)}" style="background-image:url('img/art/${c.art}')"><div class="badges">${badges.join('')}</div><div class="stat a ${a}">${u.atk}</div><div class="stat h ${h}">${u.hp}</div></div>`;
}

function renderGame() {
  const v = S.view; if (!v) return;
  const me = v.me, op = v.opp;
  const canAct = v.myTurn && !v.over && !v.pending;
  $('#hero-opp').innerHTML = heroHtml(op, false);
  $('#hero-me').innerHTML = heroHtml(me, true);
  const meTurn = v.spectator ? v.currentSeat === 0 : v.myTurn;
  $('#hero-opp').classList.toggle('active-turn', v.phase === 'play' && !meTurn && !v.over);
  $('#hero-me').classList.toggle('active-turn', v.phase === 'play' && meTurn && !v.over);
  $('.battle').classList.toggle('spectating', !!v.spectator);
  $('#hero-me').classList.toggle('low', me.hp <= 6 && !v.over);
  $('#hero-opp').classList.toggle('low', op.hp <= 6 && !v.over);
  $('#hero-opp').classList.toggle('target', isValidTarget('hero', v));
  $('#hero-opp').classList.toggle('immune', !!op.immune);
  $('#hero-me').classList.toggle('immune', !!me.immune);
  const pile = (p, extra) => `<div class="deckpile ${p.deckCount === 0 ? 'empty' : ''}" title="Talia: ${p.deckCount} kart">${p.deckCount ? '<div class="cardback"></div><div class="cardback"></div><div class="cardback"></div>' : ''}<b>${p.deckCount}</b></div><div class="pile-txt">${extra}<div title="${esc(p.grave.join(', '))}">☠ ${p.grave.length}</div></div>`;
  $('#opp-pile').innerHTML = pile(op, `<div title="Karty w ręce">✋ ${op.handCount}</div>`);
  $('#me-pile').innerHTML = pile(me, '');
  $('#mana-opp').innerHTML = manaHtml(op, false, false);
  $('#mana-me').innerHTML = manaHtml(me, true, canAct && !me.manaActionUsed);
  $('#opp-hand').innerHTML = v.spectator && op.hand
    ? op.hand.map(c => cardHtml(c.name, { cost: c.cost, attrs: `data-uid="${c.uid}"` })).join('')
    : '<div class="cardback"></div>'.repeat(op.handCount);
  if (v.spectator) $$('#opp-hand .card').forEach(el => attachPreview(el, el.dataset.name));
  $('#board-opp').innerHTML = op.board.map(u => unitHtml(u, false, v)).join('');
  $('#board-me').innerHTML = me.board.map(u => unitHtml(u, true, v)).join('');
  const n = me.hand.length;
  $('#hand-me').style.setProperty('--hm', n <= 5 ? '4px' : n <= 7 ? '-14px' : '-34px');
  const discarding = v.pending && v.pending.mine && v.pending.type === 'discard';
  $('#hand-me').innerHTML = me.hand.map(c => cardHtml(c.name, { cost: c.cost, cls: (discarding ? 'pick-discard' : c.playable ? 'playable' : '') + (S.sel && S.sel.uid === c.uid ? ' sel' : ''), attrs: `data-uid="${c.uid}"` })).join('');
  renderMulligan(v);
  renderChoice(v);
  const tb = $('#turn-banner');
  tb.textContent = v.over ? 'KONIEC GRY' : v.spectator ? (v.phase === 'mulligan' ? 'WYMIANA KART' : `👀 TURA: ${v.currentName}`) : v.myTurn ? 'TWOJA TURA' : `TURA: ${op.name}`;
  tb.classList.toggle('mine', v.myTurn && !v.over);
  const end = $('#btn-end');
  end.disabled = !canAct;
  end.classList.toggle('mine', canAct);
  end.textContent = canAct ? 'Koniec tury' : 'Tura przeciwnika';
  if (v.spectator) { end.disabled = false; end.textContent = 'Wyjdź z oglądania'; }
  const anyMove = canAct && (me.hand.some(c => c.playable) || me.board.some(u => u.canAttack) || (!me.manaActionUsed && ['T', 'W', 'B'].some(c => me.mana[c].lvl < 4)));
  end.classList.toggle('nomoves', canAct && !anyMove);
  $('#hand-me').classList.toggle('their-turn', !canAct);
  $('#log-body').innerHTML = v.log.map(l => `<div>${esc(l)}</div>`).join('');
  $('#log-body').scrollTop = 1e6;
  $('#btn-concede').disabled = v.over;
  $('#btn-concede').classList.toggle('hidden', !!v.spectator);

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
  const v = S.view, pd = v && v.pending;
  if (pd && pd.mine && pd.type === 'discard') t = S.sel && S.sel.kind === 'discard' ? 'Kliknij kartę ponownie, aby ją odrzucić' : `Wybierz kartę do odrzucenia${pd.count > 1 ? ` (jeszcze ${pd.count})` : ''}`;
  else if (pd && pd.mine && pd.type === 'resurrect') t = 'Wybierz jednostkę do wskrzeszenia';
  else if (v && v.spectator) t = v.phase === 'mulligan' ? '👀 Gracze wymieniają karty startowe…' : pd ? `👀 ${pd.who || 'Gracz'} wybiera…` : '';
  else if (pd && !pd.mine) t = pd.type === 'discard' ? 'Przeciwnik wybiera kartę do odrzucenia…' : 'Przeciwnik wybiera jednostkę do wskrzeszenia…';
  else if (S.sel && S.sel.kind === 'attacker') t = v && v.opp.board.some(x => x.taunt) ? 'Najpierw musisz zaatakować jednostkę z Prowokacją 🛡' : 'Wybierz cel ataku: wrogą jednostkę lub bohatera';
  else if (S.sel && S.sel.kind === 'spell') t = S.sel.any ? 'Wybierz cel: wrogą jednostkę lub bohatera' : 'Wybierz wrogą jednostkę';
  else if (S.sel && S.sel.kind === 'preview') t = 'Stuknij ponownie, aby zagrać';
  h.textContent = t; h.classList.toggle('show', !!t);
}

function onHandClick(uid) {
  if (S.view && S.view.spectator) return;
  const v = S.view; if (!v || v.over) return;
  const card = v.me.hand.find(c => c.uid === uid);
  const data = S.byName[card.name];
  if (v.pending && v.pending.mine && v.pending.type === 'discard') {
    // odrzucanie: pierwsze kliknięcie zaznacza, drugie potwierdza
    if (S.sel && S.sel.kind === 'discard' && S.sel.uid === uid) { S.sel = null; hidePreview(); act({ type: 'choose', uid }); }
    else { S.sel = { kind: 'discard', uid }; if (TOUCH) showTouchPreview(card.name); }
    renderGame(); return;
  }
  if (v.pending) { toast(v.pending.mine ? 'Najpierw dokończ wybór.' : 'Poczekaj, przeciwnik wybiera.'); return; }
  if (TOUCH && !(S.sel && S.sel.uid === uid)) { S.sel = { kind: 'preview', uid }; showTouchPreview(card.name); renderGame(); return; }
  hidePreview();
  if (!v.myTurn) { toast('Poczekaj na swoją turę.'); S.sel = null; renderGame(); return; }
  if (!card.playable) { toast('Nie stać Cię na tę kartę – rozbuduj miasta (+).', true); S.sel = null; renderGame(); return; }
  if (data.target === 'enemyAny') { S.sel = { kind: 'spell', uid, any: true }; renderGame(); return; }
  if (data.target === 'enemyUnit' && v.opp.board.length) { S.sel = { kind: 'spell', uid }; renderGame(); return; }
  S.sel = null;
  playCard(uid);
}

// ---------- zagranie karty z wyborem many ----------
function playCard(uid, target) {
  const v = S.view; const card = v.me.hand.find(c => c.uid === uid); if (!card) return;
  const cost = card.cost, m = v.me.mana;
  const rest = {}; let restSum = 0, cities = 0;
  for (const c of ['T', 'W', 'B']) { rest[c] = Math.max(0, m[c].lvl - m[c].used - cost[c]); restSum += rest[c]; if (rest[c] > 0) cities++; }
  // wybór ma sens tylko, gdy jest koszt dowolny i więcej niż jeden sposób zapłaty
  if (cost.D > 0 && cities >= 2 && restSum > cost.D) return showPay(card, cost, rest, pay => act({ type: 'play', uid, target, pay }));
  act({ type: 'play', uid, target });
}
function showPay(card, cost, rest, done) {
  const pay = { T: 0, W: 0, B: 0 };
  let need = cost.D;   // podpowiedź: z miast, gdzie zostało najwięcej
  while (need > 0) { const c = ['T', 'W', 'B'].filter(x => rest[x] - pay[x] > 0).sort((a, b) => (rest[b] - pay[b]) - (rest[a] - pay[a]))[0]; if (!c) break; pay[c]++; need--; }
  const draw = () => {
    const sum = pay.T + pay.W + pay.B;
    box.innerHTML = `<div class="pay-card">${cardHtml(card.name, { cost })}</div>
      <div class="pay-side"><h2>Zapłać ${cost.D} many dowolnej</h2>
      <p class="muted small">Wybierz, z których miast wziąć manę. Pozostała zostanie na później.</p>
      ${['T', 'W', 'B'].map(c => `<div class="pay-row ${rest[c] ? '' : 'off'}"><span class="mana-ic ${c}"></span><b>${CITY[c]}</b><span class="muted small">wolne: ${rest[c]}</span>
        <button class="btn small" data-m="${c}" data-d="-1" ${pay[c] ? '' : 'disabled'}>−</button><span class="pay-n">${pay[c]}</span><button class="btn small" data-m="${c}" data-d="1" ${pay[c] < rest[c] && sum < cost.D ? '' : 'disabled'}>+</button></div>`).join('')}
      <div class="row center"><button class="btn gold" id="pay-ok" ${sum === cost.D ? '' : 'disabled'}>Zagraj (${sum}/${cost.D})</button><button class="btn ghost" id="pay-no">Anuluj</button></div></div>`;
    box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { pay[b.dataset.m] += +b.dataset.d; SFX.play('click'); draw(); });
    box.querySelector('#pay-ok').onclick = () => { closeModal(); done({ ...pay }); };
    box.querySelector('#pay-no').onclick = closeModal;
  };
  const box = modal('');
  box.classList.add('pay-box');
  draw();
}
function onMyUnitClick(uid) {
  if (S.view && S.view.spectator) return;
  const v = S.view; if (!v || v.over) return;
  const u = v.me.board.find(x => x.uid === uid);
  if (TOUCH && !(S.sel && S.sel.uid === uid) && !(v.myTurn && u.canAttack)) { showTouchPreview(u.name); return; }
  if (!v.myTurn) return toast('Poczekaj na swoją turę.');
  if (!u.canAttack) return toast(u.frozen ? 'Ta jednostka jest zamrożona.' : 'Ta jednostka nie może teraz atakować.');
  S.sel = S.sel && S.sel.uid === uid ? null : { kind: 'attacker', uid };
  renderGame();
}
function onEnemyClick(target) {
  if (S.view && S.view.spectator) return;
  const v = S.view; if (!v) return;
  if (S.sel && S.sel.kind === 'attacker') {
    const taunts = v.opp.board.filter(x => x.taunt);
    if (taunts.length && !taunts.some(x => x.uid === target)) { toast('Najpierw musisz zaatakować jednostkę z Prowokacją 🛡', true); return; }
    act({ type: 'attack', uid: S.sel.uid, target }); S.sel = null; renderGame(); return;
  }
  if (S.sel && S.sel.kind === 'spell' && (target !== 'hero' || S.sel.any)) { const uid = S.sel.uid; S.sel = null; renderGame(); playCard(uid, target); return; }
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
$('#btn-end').onclick = e => {
  e.stopPropagation(); S.sel = null;
  if (S.view && S.view.spectator) { leaveSpectate(); return; }
  act({ type: 'end' });
};
function leaveSpectate() {
  send({ t: 'stopSpectate' });
  S.view = null; closeModal(); show('hub'); setTab('play');
}
function onSpectateEnd(m) {
  if (!S.view || !S.view.spectator) return;
  setTimeout(() => {
    const box = modal(`<div class="big win">Koniec gry</div><p><b>${esc(m.winner)}</b> pokonał(a) <b>${esc(m.loser)}</b>${m.reason === 'concede' ? ' (poddanie)' : m.reason === 'forfeit' ? ' (walkower)' : ''}.</p><button class="btn gold" id="go-lobby">Wróć do menu</button>`);
    box.querySelector('#go-lobby').onclick = () => { closeModal(); S.view = null; show('hub'); setTab('play'); };
  }, 900);
}
$('#btn-concede').onclick = e => {
  e.stopPropagation();
  const box = modal('<h2>Poddać się?</h2><p class="muted">Przeciwnik dostanie zwycięstwo i złoto.</p><div class="row center"><button class="btn danger" id="cq-yes">Poddaję się</button><button class="btn ghost" id="cq-no">Gram dalej</button></div>');
  box.querySelector('#cq-yes').onclick = () => { act({ type: 'concede' }); closeModal(); };
  box.querySelector('#cq-no').onclick = closeModal;
};
$('#log').addEventListener('click', e => { if (innerWidth <= 1100 && e.target.closest('.log-head') && !e.target.closest('button')) $('#log').classList.toggle('collapsed'); });
if (innerWidth <= 1100) $('#log').classList.add('collapsed');

// ---------- wymiana kart startowych ----------
function renderMulligan(v) {
  const box = $('#mulligan');
  if (v.phase !== 'mulligan' || v.over || v.spectator) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const done = v.mulligan && v.mulligan.me;
  if (!S.mullSel) S.mullSel = new Set();
  // aktualizujemy karty na miejscu – istniejące zostają, animują się tylko nowe (bez migania przy każdej zmianie)
  const wrap = $('#mull-cards');
  const existing = new Map([...wrap.children].map(el => [el.dataset.uid, el]));
  const nodes = v.me.hand.map(c => {
    let el = existing.get(c.uid);
    if (!el) { el = document.createElement('div'); el.className = 'mull-card'; el.dataset.uid = c.uid; el.innerHTML = `${cardHtml(c.name)}<span class="x">✕ wymień</span>`; }
    el.classList.toggle('swap', !done && S.mullSel.has(c.uid));
    return el;
  });
  if (nodes.length !== wrap.children.length || nodes.some((n, k) => wrap.children[k] !== n)) wrap.replaceChildren(...nodes);
  $('#mull-title').textContent = done ? 'Twoja ręka startowa' : 'Wymiana kart startowych';
  $('#mull-help').textContent = done ? '' : 'Kliknij karty, których nie chcesz – dostaniesz zamiast nich nowe z talii.';
  const btn = $('#btn-mull');
  btn.classList.toggle('hidden', !!done);
  btn.textContent = S.mullSel.size ? `Wymień ${S.mullSel.size} i graj` : 'Zostaw rękę i graj';
  $$('#mull-cards .mull-card').forEach(el => {
    el.onclick = e => { e.stopPropagation(); if (S.view.mulligan && S.view.mulligan.me) return; const u = el.dataset.uid; S.mullSel.has(u) ? S.mullSel.delete(u) : S.mullSel.add(u); SFX.play('click'); renderMulligan(S.view); };
  });
  clearInterval(S.mullTimer);
  const tick = () => {
    const left = v.mulliganEndsAt ? Math.max(0, Math.ceil((v.mulliganEndsAt - Date.now()) / 1000)) : null;
    $('#mull-info').textContent = (done ? (v.mulligan.opp ? '' : 'Czekam, aż przeciwnik wymieni karty… ') : '') + (left != null ? `Pozostało ${left} s` : '');
  };
  tick(); S.mullTimer = setInterval(() => { if (S.view && S.view.phase === 'mulligan') tick(); else clearInterval(S.mullTimer); }, 500);
}
$('#btn-mull').onclick = e => { e.stopPropagation(); act({ type: 'mulligan', uids: [...(S.mullSel || [])] }); S.mullSel = new Set(); };

// ---------- wybór jednostki do wskrzeszenia ----------
function renderChoice(v) {
  const box = $('#choice');
  const pd = v.pending;
  if (!pd || !pd.mine || pd.type !== 'resurrect' || v.over) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#choice-cards').innerHTML = (pd.options || []).map(n => `<div class="mull-card" data-name="${esc(n)}">${cardHtml(n)}</div>`).join('');
  $$('#choice-cards .mull-card').forEach(el => {
    el.onclick = e => { e.stopPropagation(); hidePreview(); act({ type: 'choose', name: el.dataset.name }); box.classList.add('hidden'); };
  });
}

// efekty: liczby obrażeń, animacje wejścia, zagrana karta przeciwnika
function floatAt(el, text, cls) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'float ' + cls + (Math.abs(parseInt(text, 10)) >= 5 ? ' big' : ''); f.textContent = text;
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
  setTimeout(() => {
  let reward = '';
  if (win) {
    reward = `<p>Nagroda: <b class="gold-t">+${m.reward.gold} złota</b></p>`;
    if (m.reward.bonus) reward += `<p class="gold-t" style="font-size:20px"><b>BONUS +${m.reward.bonus} złota!</b><br><span class="small muted">Pokonałeś 5 różnych graczy – seria zaczyna się od nowa.</span></p>`;
    else reward += `<p class="small muted">Seria: pokonani ${S.me ? S.me.defeated.length : '?'}/5 różnych graczy</p>`;
  }
    SFX.play(win ? 'win' : 'lose');
    if (win) confetti(); else $('.battle').classList.add('defeat');
    const box = modal(`<div class="big ${win ? 'win' : 'loss'}">${win ? 'ZWYCIĘSTWO!' : 'Porażka'}</div><p>${win ? 'Pokonałeś' : 'Przegrałeś z'} <b>${esc(m.opponent)}</b>. ${esc(reason)}</p>${reward}<button class="btn gold" id="go-lobby">Wróć do menu</button>`);
    box.querySelector('#go-lobby').onclick = () => { closeModal(); S.view = null; show('hub'); setTab('play'); };
  }, 900);
}

function confetti() {
  const colors = ['#f2c14e', '#ff6b5a', '#5fd068', '#59b7ff', '#b9a0ff', '#fff'];
  for (let i = 0; i < 120; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.cssText = `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};width:${6 + Math.random() * 6}px;height:${8 + Math.random() * 10}px`;
    document.body.appendChild(d);
    d.animate([{ transform: `translateY(-20px) rotate(0deg)`, opacity: 1 }, { transform: `translate(${(Math.random() - 0.5) * 200}px, 105vh) rotate(${Math.random() * 900}deg)`, opacity: 0.9 }], { duration: 2200 + Math.random() * 1800, delay: Math.random() * 600, easing: 'cubic-bezier(.3,.4,.6,1)' }).onfinish = () => d.remove();
  }
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
updateMuteButtons();
connect();
// klik w tło okienka zamyka je (poza ekranem końca gry i wyzwaniem)
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !$('#go-lobby') && !$('#acc-yes')) closeModal(); });
