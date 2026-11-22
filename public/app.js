'use strict';
/* Sincro Music - cliente. Sin frameworks ni build: se edita y se recarga. */

/* ------------------------------ utilidades ------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, opts = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('sincro.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sincro.' + k, JSON.stringify(v)); } catch {} },
};
function toast(text, kind) {
  const t = el('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36));

const EMOJIS = ['🔥', '❤️', '😂', '💀', '👏', '😭', '🤯', '👎'];
const PRESETS = {
  Medianoche: { bg: '#0f1117', panel: '#181b24', text: '#e8eaf0', accent: '#7c5cff', accent2: '#ff5c8a' },
  Neón: { bg: '#0a0a14', panel: '#13132a', text: '#f2f2ff', accent: '#00f0ff', accent2: '#ff2fd6' },
  Atardecer: { bg: '#1b1020', panel: '#2a1730', text: '#fff1e6', accent: '#ff8a3d', accent2: '#ff3d81' },
  Bosque: { bg: '#0e1512', panel: '#16211c', text: '#e7f3ec', accent: '#3ddc97', accent2: '#b8e84a' },
  Océano: { bg: '#0a141f', panel: '#102233', text: '#e6f1fb', accent: '#3da5ff', accent2: '#6df0e0' },
  Claro: { bg: '#f3f4f8', panel: '#ffffff', text: '#1c1f2a', accent: '#6a4cff', accent2: '#e5457a' },
};
function lum(hex) {
  const ch = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
function mixHex(a, b, k) {
  const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => hex2(c(a, i) + (c(b, i) - c(a, i)) * k)).join('');
}
/** Devuelve el color pedido; si no se lee sobre el fondo, lo aclara u oscurece lo justo (en vez de ignorarlo). */
function fitColor(color, bg, min = 3) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color) || !bg) return null;
  if (contrast(color, bg) >= min) return color;
  const target = lum(bg) < 0.4 ? '#ffffff' : '#000000';
  for (let k = 0.1; k <= 1.001; k += 0.1) {
    const c = mixHex(color, target, k);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}
const lowContrast = (t) => contrast(t.text, t.bg) < 3 || contrast(t.text, t.panel) < 3;
const DRIFT = 1.2; // segundos de diferencia tolerados antes de resincronizar

/* -------------------------------- estado -------------------------------- */
const S = {
  clientId: store.get('cid', null) || uuid(),
  nick: store.get('nick', ''),
  ws: null,
  intent: null,
  joined: false,
  closing: false,
  retry: 0,
  you: null,
  room: null,
  offset: 0,
  bestRtt: Infinity,
  pingTimer: null,
  ytReady: false,
  player: null,
  playerReady: false,
  curItemId: null,
  lastSeekAt: 0,
  endReported: false,
  errReported: false,
  stuck: 0,
  seeking: false,
  volume: store.get('vol', 80),
  myTheme: store.get('theme', null),
  useMine: store.get('useMine', false),
  themeDraft: null,
  chatColor: store.get('chatColor', null),
  textColor: store.get('textColor', null),
  fsChat: store.get('fsChat', true),
  kbOn: false,
  syncOkAt: 0,
  lastJumpAt: 0,
  nativeControls: store.get('nativeControls', false),
  searchEnabled: false,
  needsCode: false,
  searchCode: store.get('searchCode', null),
  pendingQuery: null,
  chat: [],
  emoteDraft: null,
  sentThemeAt: 0,
};
store.set('cid', S.clientId);

/* -------------------------------- vistas -------------------------------- */
function showView(name) {
  $('#view-lobby').classList.toggle('hidden', name !== 'lobby');
  $('#view-room').classList.toggle('hidden', name !== 'room');
}

function applyTheme(t) {
  const root = document.documentElement.style;
  for (const k of ['bg', 'panel', 'text', 'accent', 'accent2']) root.setProperty('--' + k, t[k]);
  // salvavidas: si el texto no se lee sobre el fondo, se usa blanco o negro según corresponda
  if (lowContrast(t)) {
    const darkBg = (lum(t.bg) + lum(t.panel)) / 2 < 0.4;
    root.setProperty('--text', darkBg ? '#ffffff' : '#111111');
  }
}
function effectiveTheme() {
  if (S.useMine && S.myTheme) return S.myTheme;
  if (S.room) return S.room.theme;
  return PRESETS.Medianoche;
}

/* ------------------------------- conexión ------------------------------- */
function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function connect(intent) {
  S.closing = false;
  S.intent = intent;
  S.joined = false;
  openSocket();
}

function openSocket() {
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch { return toast(t('room.noConnect'), 'error'); }
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    hideBanner();
    const i = S.intent;
    if (i.action === 'create') send({ type: 'create', clientId: S.clientId, nick: S.nick, name: i.name, public: i.isPublic, color: S.chatColor, tcolor: S.textColor });
    else send({ type: 'join', clientId: S.clientId, nick: S.nick, code: i.code, color: S.chatColor, tcolor: S.textColor });
    startClockSync();
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    stopClockSync();
    if (S.closing) return;
    if (!S.joined) {
      toast(t('room.noConnectRoom'), 'error');
      return backToLobby();
    }
    showBanner(t('room.reconnecting'));
    const wait = Math.min(1000 * 2 ** S.retry++, 8000);
    setTimeout(() => {
      if (S.closing || S.ws !== ws) return;
      S.intent = { action: 'join', code: S.room.code };
      openSocket();
    }, wait);
  };
}

function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

function startClockSync() {
  stopClockSync();
  S.bestRtt = Infinity;
  let n = 0;
  const tick = () => {
    send({ type: 'ping', t: Date.now() });
    n++;
  };
  tick();
  S.pingTimer = setInterval(() => { tick(); if (n > 4) { clearInterval(S.pingTimer); S.pingTimer = setInterval(tick, 15000); } }, 300);
}
function stopClockSync() { clearInterval(S.pingTimer); S.pingTimer = null; }

function showBanner(t) { const b = $('#conn-banner'); b.textContent = t; b.classList.remove('hidden'); }
function hideBanner() { $('#conn-banner').classList.add('hidden'); }

function backToLobby() {
  S.closing = true;
  if (S.ws) { try { S.ws.close(); } catch {} }
  S.ws = null; S.room = null; S.you = null; S.joined = false; S.curItemId = null;
  if (S.playerReady) { try { S.player.stopVideo(); } catch {} }
  history.replaceState(null, '', location.pathname);
  applyTheme(PRESETS.Medianoche);
  S.chat = [];
  $('#chat-log').replaceChildren();
  $('#fs-chat-log').replaceChildren();
  $('#emote-picker').classList.add('hidden');
  hideResults();
  showView('lobby');
  refreshPublicRooms();
}

/* ------------------------------- mensajes ------------------------------- */
function onMessage(m) {
  switch (m.type) {
    case 'pong': {
      const t1 = Date.now();
      const rtt = t1 - m.t;
      if (rtt <= S.bestRtt) { S.bestRtt = rtt; S.offset = m.s + rtt / 2 - t1; }
      break;
    }
    case 'room': {
      const first = !S.joined;
      const prevTheme = S.room && JSON.stringify(S.room.theme);
      S.joined = true;
      S.room = m.room;
      if (!first && prevTheme && prevTheme !== JSON.stringify(m.room.theme)) {
        if (Date.now() - S.sentThemeAt > 3000) toast(S.useMine ? t('room.themeChangedMine') : t('room.themeChanged'));
      }
      S.you = m.you;
      if (first) enterRoomView();
      renderRoom();
      syncPlayer();
      break;
    }
    case 'history':
      S.chat = [];
      $('#chat-log').replaceChildren();
      $('#fs-chat-log').replaceChildren();
      (m.chat || []).forEach(addChat);
      break;
    case 'chat': addChat(m.msg); break;
    case 'reaction':
      floatEmoji(m.emoji, m.nick);
      if (S.room) { S.room.reactions = m.counts; renderReactions(); }
      break;
    case 'error':
      toast(m.key ? t('err.' + m.key) : (m.message || t('err.generic')), 'error');
      if (!S.joined && ['notfound', 'banned', 'full', 'nick', 'rate'].includes(m.code)) backToLobby();
      break;
    case 'kicked':
      toast(t('room.kicked'), 'error');
      backToLobby();
      break;
  }
}

function enterRoomView() {
  history.replaceState(null, '', '#' + S.room.code);
  showView('room');
  initPlayer();
  setTimeout(() => { if (!S.ytReady) showBanner(t('room.noPlayer')); }, 9000);
}

/* ------------------------------ permisos ------------------------------- */
const me = () => S.room && S.room.members.find((x) => x.id === S.you);
const isHost = () => me() && me().role === 'host';
const canControl = () => me() && (me().role === 'host' || me().role === 'admin');
const canQueue = () => canControl() || (S.room && S.room.settings.everyoneQueue);

/* ------------------------------- render -------------------------------- */
function renderRoom() {
  const r = S.room;
  $('#room-title').textContent = r.name;
  $('#room-badge').textContent = r.isPublic ? t('room.public') : t('room.private');
  $('#room-code').textContent = r.code;
  $('#btn-settings').classList.toggle('hidden', !isHost());
  $('#set-everyone').checked = !!r.settings.everyoneQueue;
  $('#set-emotes').checked = !!r.settings.everyoneEmotes;
  if (!S.themeDraft) applyTheme(effectiveTheme());
  renderMembers();
  renderQueue();
  renderHistory();
  renderNowPlaying();
  buildReactBar();
  renderReactions();
  renderEmotes();
  if (S.player && S.nativeControls && S.kbOn !== kbEnabled()) recreatePlayer(); // cambió su rol: el teclado de YouTube se activa o desactiva
}

function roleBadge(role) { return role === 'host' ? '👑' : role === 'admin' ? '⭐' : ''; }

function renderMembers() {
  const r = S.room;
  const list = $('#member-list');
  list.replaceChildren();
  const order = { host: 0, admin: 1, member: 2 };
  const sorted = [...r.members].sort((a, b) => order[a.role] - order[b.role]);
  $('#member-count').textContent = `(${r.members.filter((m) => m.online).length})`;
  const myRole = me() && me().role;
  for (const m of sorted) {
    const acts = el('div', { class: 'acts' });
    if (m.id !== S.you && m.role !== 'host') {
      if (myRole === 'host') {
        acts.append(
          el('button', { class: 'mini', title: m.role === 'admin' ? t('members.removeAdmin') : t('members.makeAdmin'), text: m.role === 'admin' ? '⭐−' : '⭐+', onclick: () => send({ type: 'setRole', target: m.id, admin: m.role !== 'admin' }) }),
          el('button', { class: 'mini', title: t('members.giveHost'), text: '👑', onclick: () => confirm(t('members.confirmHost', { nick: m.nick })) && send({ type: 'transferHost', target: m.id }) }),
        );
      }
      if (myRole === 'host' || (myRole === 'admin' && m.role === 'member')) {
        acts.append(el('button', { class: 'mini danger', title: t('members.kick'), text: '🚫', onclick: () => confirm(t('members.confirmKick', { nick: m.nick })) && send({ type: 'kick', target: m.id }) }));
      }
    }
    const col = fitColor(m.color, effectiveTheme().panel);
    const n = el('div', { class: 'n', style: col ? `color:${col}` : null }, document.createTextNode(m.nick + (m.id === S.you ? ' ' + t('room.you') : '')), el('i', { text: roleBadge(m.role) }));
    list.append(el('li', { class: m.online ? '' : 'offline' }, n, acts));
  }
}

function renderQueue() {
  const r = S.room;
  const list = $('#queue-list');
  list.replaceChildren();
  $('#queue-count').textContent = r.queue.length ? `(${r.queue.length})` : '';
  const ctl = canControl();
  r.queue.forEach((it, i) => {
    const li = el('li', { draggable: ctl ? 'true' : null },
      ctl ? el('span', { class: 'grip', title: t('queue.drag'), text: '⋮⋮' }) : null,
      el('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(it.videoId)}/default.jpg`, alt: '', loading: 'lazy', draggable: 'false' }),
      el('div', { class: 't' }, el('div', { text: it.title }), el('div', { text: t('np.addedBy', { nick: it.by }) })),
    );
    if (ctl) {
      li.append(
        el('button', { class: 'mini', title: t('queue.moveNext'), text: '⏫', onclick: () => send({ type: 'move', itemId: it.id, index: 0 }) }),
        el('button', { class: 'mini', title: t('queue.playNow'), text: '▶', onclick: () => send({ type: 'playNow', itemId: it.id }) }),
        el('button', { class: 'mini danger', title: t('queue.remove'), text: '✕', onclick: () => send({ type: 'remove', itemId: it.id }) }),
      );
      // arrastrar y soltar para reordenar
      const isAfter = (e) => { const b = li.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; };
      li.addEventListener('dragstart', (e) => {
        S.dragId = it.id;
        li.classList.add('dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', it.id); } catch {} }
      });
      li.addEventListener('dragend', () => { S.dragId = null; clearDropMarks(); li.classList.remove('dragging'); });
      li.addEventListener('dragover', (e) => {
        if (!S.dragId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        clearDropMarks();
        li.classList.add(isAfter(e) ? 'drop-after' : 'drop-before');
      });
      li.addEventListener('drop', (e) => {
        if (!S.dragId) return;
        e.preventDefault();
        const from = S.room.queue.findIndex((x) => x.id === S.dragId);
        let target = i + (isAfter(e) ? 1 : 0);
        if (from >= 0 && from < target) target--; // al sacar el original, los de abajo suben un lugar
        clearDropMarks();
        if (from >= 0 && target !== from) send({ type: 'move', itemId: S.dragId, index: target });
        S.dragId = null;
      });
    }
    list.append(li);
  });
  if (!r.queue.length) list.append(el('li', { class: 'muted', text: t('queue.empty') }));
  const form = $('#add-form');
  const note = $('#add-note');
  form.classList.toggle('hidden', !canQueue());
  note.classList.toggle('hidden', canQueue());
  note.textContent = t('queue.noPerm');
  $('#idle-hint').textContent = canQueue() ? t('room.hintCanQueue') : t('room.hintWait');
}

function clearDropMarks() {
  document.querySelectorAll('#queue-list .drop-before, #queue-list .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function renderHistory() {
  const r = S.room;
  const list = $('#history-list');
  list.replaceChildren();
  const playing = r.current && r.current.videoId;
  const items = (r.history || []).filter((h) => h.videoId !== playing);
  $('#history-count').textContent = items.length ? `(${items.length})` : '';
  for (const h of items) {
    const li = el('li', {},
      el('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(h.videoId)}/default.jpg`, alt: '', loading: 'lazy' }),
      el('div', { class: 't' }, el('div', { text: h.title }), el('div', { text: t('np.addedBy', { nick: h.by }) })),
    );
    if (canControl()) li.append(el('button', { class: 'mini', title: t('queue.playNow'), text: '▶', onclick: () => send({ type: 'playFromHistory', itemId: h.id }) }));
    if (canQueue()) {
      li.append(
        el('button', { class: 'mini', title: t('queue.addEnd'), text: t('queue.btnEnd'), onclick: () => send({ type: 'queueFromHistory', itemId: h.id }) }),
        el('button', { class: 'mini', title: t('queue.addNext'), text: t('queue.btnNext'), onclick: () => send({ type: 'queueFromHistory', itemId: h.id, next: true }) }),
      );
    }
    list.append(li);
  }
  if (!items.length) list.append(el('li', { class: 'muted', text: t('history.empty') }));
}

function renderNowPlaying() {
  const r = S.room;
  const cur = r.current;
  $('#np-title').textContent = cur ? cur.title : '—';
  $('#fs-title').textContent = cur ? cur.title : '';
  $('#np-by').textContent = cur ? t('np.addedBy', { nick: cur.by }) : '';
  $('#idle').classList.toggle('hidden', !!cur);
  const ctl = canControl();
  const pp = $('#btn-playpause');
  pp.textContent = r.playing ? '⏸' : '▶';
  pp.disabled = !ctl || !cur;
  $('#btn-next').disabled = !ctl || !cur;
  $('#seek').disabled = !ctl || !cur;
  pp.title = ctl ? t('np.playPause') : t('np.onlyCtl');
}

const emoteByKey = (key) => {
  const m = typeof key === 'string' && key.match(/^:([a-z0-9_]{2,20}):$/);
  return m && S.room ? (S.room.emotes || []).find((e) => e.name === m[1]) : null;
};
function reactionNode(key, extraClass) {
  const e = emoteByKey(key);
  if (e) return el('img', { class: 'emote' + (extraClass ? ' ' + extraClass : ''), src: emoteUrl(e), alt: key });
  return document.createTextNode(key);
}

function renderReactions() {
  const box = $('#react-counts');
  box.replaceChildren();
  const rc = (S.room && S.room.reactions) || {};
  const keys = [...EMOJIS, ...Object.keys(rc).filter((k) => !EMOJIS.includes(k)).sort()];
  for (const k of keys) {
    if (!rc[k]) continue;
    if (!EMOJIS.includes(k) && !emoteByKey(k)) continue;
    box.append(el('span', {}, reactionNode(k), document.createTextNode(' ' + rc[k])));
  }
}

let reactLast = 0;
let reactSig = null;
/** Botones de reacción: los emojis de siempre + los emotes de la sala. Se rearma solo si cambian los emotes. */
function buildReactBar() {
  const list = (S.room && S.room.emotes) || [];
  const sig = list.map((e) => e.name + e.v).join('|');
  if (sig === reactSig) return;
  reactSig = sig;
  for (const sel of ['#react-bar', '#fs-react']) {
    const bar = $(sel);
    bar.replaceChildren();
    const keys = [...EMOJIS, ...list.map((e) => ':' + e.name + ':')];
    for (const k of keys) {
      const b = el('button', { title: EMOJIS.includes(k) ? t('np.react') : k, onclick: () => {
        if (Date.now() - reactLast < 150) return;
        reactLast = Date.now();
        send({ type: 'react', emoji: k });
      } });
      b.append(reactionNode(k));
      bar.append(b);
    }
  }
}

function floatEmoji(emoji, nick) {
  const layer = $('#float-layer');
  const f = el('div', { class: 'float', style: `left:${8 + Math.random() * 80}%` }, reactionNode(emoji, 'float-emote'), el('small', { text: nick }));
  layer.append(f);
  setTimeout(() => f.remove(), 2600);
  while (layer.children.length > 40) layer.firstChild.remove();
}

/* --------------------------------- chat --------------------------------- */
function nickColor(nick) {
  let h = 0;
  for (const c of nick) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 62%)`;
}
const hhmm = (ms) => {
  const d = new Date(ms || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
function sysText(msg) {
  if (!msg.key) return msg.text || '';
  const p = msg.params || {};
  let out = t('sys.' + msg.key, p);
  if (msg.key === 'playlist' && p.skipped) out += t('sys.playlistSkipped', p);
  return out;
}
/** Convierte :nombre: en la imagen del emote si existe en la sala; el resto va como texto (nunca como HTML). */
function richText(text) {
  const frag = document.createDocumentFragment();
  const emotes = new Map(((S.room && S.room.emotes) || []).map((e) => [e.name, e]));
  let last = 0;
  for (const m of text.matchAll(/:([a-z0-9_]{2,20}):/g)) {
    const e = emotes.get(m[1]);
    if (!e) continue;
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    frag.append(el('img', { class: 'emote', src: emoteUrl(e), alt: ':' + e.name + ':', title: ':' + e.name + ':' }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
const emoteUrl = (e) => `/emote/${S.room.code}/${e.name}.png?v=${encodeURIComponent(e.v)}`;

function appendTo(log, msg, mine) {
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.append(chatNode(msg));
  while (log.children.length > 200) log.firstChild.remove();
  if (near || mine) log.scrollTop = log.scrollHeight;
}
function addChat(msg) {
  S.chat.push(msg);
  while (S.chat.length > 200) S.chat.shift();
  const mine = !!(S.room && msg.pid === S.you);
  appendTo($('#chat-log'), msg, mine);
  appendTo($('#fs-chat-log'), msg, mine); // el chat que se ve en pantalla completa
}
function chatNode(msg) {
  const time = el('span', { class: 'time', text: hhmm(msg.t) });
  if (msg.system) return el('div', { class: 'sys' }, time, document.createTextNode(sysText(msg)));
  // colores elegidos por la persona (nombre y texto por separado); si no se leen sobre el fondo, se ajustan
  const panel = effectiveTheme().panel;
  const nickCol = fitColor(msg.color, panel) || nickColor(msg.nick);
  const textCol = fitColor(msg.tcolor, panel);
  const body = el('span', { class: 'body', style: textCol ? `color:${textCol}` : null });
  body.append(richText(msg.text));
  return el('div', { class: 'msg' },
    time,
    el('b', { style: `color:${nickCol}`, text: msg.nick }),
    document.createTextNode(': '),
    body);
}
function rebuildChat() {
  for (const log of [$('#chat-log'), $('#fs-chat-log')]) {
    log.replaceChildren(...S.chat.map(chatNode));
    log.scrollTop = log.scrollHeight;
  }
}

/* -------------------------------- emotes -------------------------------- */
const canEmote = () => canControl() || (S.room && S.room.settings.everyoneEmotes);

function renderEmotes() {
  const picker = $('#emote-picker');
  picker.replaceChildren();
  const list = (S.room && S.room.emotes) || [];
  for (const e of list) {
    picker.append(el('button', { type: 'button', class: 'emote-pick', title: ':' + e.name + ':', onclick: () => {
      const inp = $('#chat-input');
      inp.value = (inp.value + (inp.value && !/\s$/.test(inp.value) ? ' ' : '') + ':' + e.name + ': ').slice(0, 300);
      inp.focus();
    } }, el('img', { class: 'emote', src: emoteUrl(e), alt: ':' + e.name + ':' })));
  }
  if (!list.length) picker.append(el('div', { class: 'muted', text: t('emote.none') }));
  picker.append(el('button', { type: 'button', class: 'mini manage', text: t('emote.manage'), onclick: () => { picker.classList.add('hidden'); openEmoteDialog(); } }));
  // lista dentro del diálogo
  const ul = $('#emote-list');
  ul.replaceChildren();
  for (const e of list) {
    ul.append(el('li', {},
      el('img', { class: 'emote big', src: emoteUrl(e), alt: '' }),
      el('div', { class: 't' }, el('div', { text: ':' + e.name + ':' }), el('div', { class: 'muted', text: t('emote.byLabel', { nick: e.by }) })),
      canControl() ? el('button', { class: 'mini danger', title: t('emote.remove'), text: '✕', onclick: () => send({ type: 'removeEmote', name: e.name }) }) : null));
  }
  $('#emote-admin-form').classList.toggle('hidden', !canEmote());
  $('#emote-noperm').classList.toggle('hidden', !!canEmote());
}

function openEmoteDialog() {
  $('#emote-file').value = '';
  $('#emote-name').value = '';
  $('#emote-preview').classList.add('hidden');
  S.emoteDraft = null;
  renderEmotes();
  $('#emote-dialog').showModal();
}

/** Achica el PNG en el navegador (máx. 96 px; si pesa mucho, 64 y 48) y devuelve el base64 sin el prefijo. */
function shrinkPng(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const max of [96, 64, 48]) {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const b64 = c.toDataURL('image/png').split(',')[1] || '';
        if (b64.length <= 54000) return resolve(b64);
      }
      reject(new Error(t('emote.tooBig')));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('emote.readFail'))); };
    img.src = url;
  });
}

function buildEmoteUi() {
  $('#btn-emote').addEventListener('click', () => $('#emote-picker').classList.toggle('hidden'));
  $('#emote-close').addEventListener('click', () => $('#emote-dialog').close());
  $('#emote-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    S.emoteDraft = null;
    $('#emote-preview').classList.add('hidden');
    if (!f) return;
    if (f.type !== 'image/png') { e.target.value = ''; return toast(t('emote.onlyPng'), 'error'); }
    if (!$('#emote-name').value) $('#emote-name').value = f.name.replace(/\.png$/i, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
    try {
      S.emoteDraft = await shrinkPng(f);
      const p = $('#emote-preview');
      p.src = 'data:image/png;base64,' + S.emoteDraft;
      p.classList.remove('hidden');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#emote-upload').addEventListener('click', () => {
    const name = $('#emote-name').value.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,20}$/.test(name)) return toast(t('emote.badName'), 'error');
    if (!S.emoteDraft) return toast(t('emote.onlyPng'), 'error');
    send({ type: 'addEmote', name, data: S.emoteDraft });
    toast(t('emote.added', { name }));
    $('#emote-file').value = '';
    $('#emote-name').value = '';
    $('#emote-preview').classList.add('hidden');
    S.emoteDraft = null;
  });
  $('#set-emotes').addEventListener('change', (e) => send({ type: 'settings', everyoneEmotes: e.target.checked }));
  $('#btn-key').addEventListener('click', () => openCodeDialog());
  $('#access-ok').addEventListener('click', submitAccessCode);
  $('#access-code').addEventListener('keydown', (e) => e.key === 'Enter' && submitAccessCode());
  $('#access-copylink').addEventListener('click', async () => {
    if (!S.searchCode) return;
    const link = location.origin + '/#k=' + encodeURIComponent(S.searchCode);
    try { await navigator.clipboard.writeText(link); toast(t('access.linkCopied')); } catch { toast(link); }
  });
  $('#access-cancel').addEventListener('click', () => { S.pendingQuery = null; $('#code-dialog').close(); });
  $('#access-forget').addEventListener('click', () => {
    S.searchCode = null;
    store.set('searchCode', null);
    $('#code-dialog').close();
    updateAddPlaceholder();
    toast(t('access.forgot'));
  });
}

/* --------------------------------- idioma -------------------------------- */
function setLanguage(lang) {
  if (!DICT[lang]) return;
  LANG = lang;
  store.set('lang', lang);
  reactSig = null;
  applyStaticI18n();
  updateAddPlaceholder();
  if (S.room) { renderRoom(); rebuildChat(); }
  refreshPublicRooms();
}

/* ------------------------- reproductor de YouTube ------------------------ */
window.onYouTubeIframeAPIReady = () => {
  S.ytReady = true;
  if (S.room) initPlayer();
};

// el teclado de YouTube (flechas, "Saltar adelante" de Premium, Enter) solo se activa para quien controla la sala:
// si adelanta el video, se adelanta para todos. Para el resto sigue desactivado.
const kbEnabled = () => S.nativeControls && canControl();

function initPlayer() {
  if (S.player || !S.ytReady || !window.YT || !YT.Player) return;
  S.kbOn = kbEnabled();
  // Cada reproductor sabe quién es: si llega un aviso de uno viejo (ya reemplazado), se ignora.
  const pl = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: { controls: S.nativeControls ? 1 : 0, disablekb: S.kbOn ? 0 : 1, fs: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, origin: location.origin },
    events: {
      onReady: () => { if (S.player !== pl) return; S.playerReady = true; S.syncOkAt = Date.now(); S.player.setVolume(S.volume); hideBanner(); syncPlayer(); },
      onStateChange: (e) => { if (S.player === pl) onPlayerState(e); },
      onError: (e) => { if (S.player === pl) onPlayerError(e); },
    },
  });
  S.player = pl;
}

function serverNow() { return Date.now() + S.offset; }
function targetPos() {
  const r = S.room;
  if (!r || !r.current) return 0;
  return r.playing ? r.pos + (serverNow() - r.at) / 1000 : r.pos;
}

function syncPlayer() {
  if (!S.playerReady || !S.room) return;
  const r = S.room;
  const p = S.player;
  if (!r.current) {
    if (S.curItemId) { try { p.stopVideo(); } catch {} S.curItemId = null; }
    $('#unlock').classList.add('hidden');
    return;
  }
  const t = targetPos();
  if (S.curItemId !== r.current.id) {
    S.curItemId = r.current.id;
    S.endReported = false;
    S.errReported = false;
    S.stuck = 0;
    S.syncOkAt = Date.now();
    const opts = { videoId: r.current.videoId, startSeconds: t };
    if (r.playing) p.loadVideoById(opts); else p.cueVideoById(opts);
    return;
  }
  const st = p.getPlayerState();
  const cur = p.getCurrentTime ? p.getCurrentTime() : 0;
  try { if (p.getPlaybackRate && p.getPlaybackRate() !== 1) p.setPlaybackRate(1); } catch {} // la velocidad rompería la sincronización
  if (r.playing) {
    if (st === 0) return; // terminó acá; esperamos que el servidor avance
    if (st === 2 && S.nativeControls) {
      p.playVideo(); // pausó con los controles de YouTube: la sala lo devuelve a su punto
    } else if (st === 2 || st === 5 || st === -1) {
      p.playVideo();
      S.stuck++;
    } else {
      S.stuck = 0;
    }
    if (Math.abs(cur - t) > DRIFT && Date.now() - S.lastSeekAt > 2500 && (st === 1 || st === 3 || st === 2)) {
      p.seekTo(t, true);
      S.lastSeekAt = Date.now();
    }
  } else {
    if (st === 1 || st === 3) p.pauseVideo();
    if (Math.abs(cur - t) > 0.8 && Date.now() - S.lastSeekAt > 800) {
      p.seekTo(t, true);
      S.lastSeekAt = Date.now();
    }
    S.stuck = 0;
  }
  $('#unlock').classList.toggle('hidden', !(r.playing && S.stuck >= 2));
}

function onPlayerState(e) {
  if (!S.room || !S.room.current) return;
  const PS = YT.PlayerState;
  if (e.data === PS.ENDED && !S.endReported) {
    S.endReported = true;
    send({ type: 'ended', itemId: S.curItemId });
  }
  if (e.data === PS.PLAYING) {
    S.stuck = 0;
    $('#unlock').classList.add('hidden');
    if (S.room.current.titleUnknown) {
      try {
        const title = S.player.getVideoData().title;
        if (title) send({ type: 'setTitle', itemId: S.curItemId, title });
      } catch {}
    }
  }
}

function onPlayerError(e) {
  if (!S.room || !S.room.current || S.errReported) return;
  S.errReported = true;
  toast(t('player.cantPlay'), 'error');
  send({ type: 'trackError', itemId: S.curItemId, code: e.data });
}

function updateProgress() {
  if (!S.room || !S.room.current) { $('#time').textContent = '0:00 / 0:00'; $('#seek').value = 0; return; }
  let dur = 0;
  try { dur = (S.playerReady && S.player.getDuration()) || 0; } catch {}
  const pos = Math.min(targetPos(), dur || Infinity);
  $('#time').textContent = `${fmt(pos)} / ${fmt(dur)}`;
  if (!S.seeking && dur) $('#seek').value = Math.round((pos / dur) * 1000);
}

/* ------------------- controles de YouTube (CC / calidad) ------------------- */
function applyNativeControlsUi() {
  $('#player-shield').classList.toggle('open', S.nativeControls);
  $('.player-wrap').classList.toggle('native', S.nativeControls);
  $('#btn-yt').classList.toggle('active', S.nativeControls);
}
function setNativeControls(on) {
  S.nativeControls = on;
  store.set('nativeControls', on);
  applyNativeControlsUi();
  if (!S.player) return;
  recreatePlayer();
  if (on) {
    toast(t('player.ytOn'));
    if (canControl()) toast(t('player.ytOnCtl'));
  }
}
/** Los controles y el teclado se definen al crear el reproductor: se vuelve a crear y la sala lo deja en el mismo punto. */
function recreatePlayer() {
  const old = S.player;
  S.player = null;
  S.playerReady = false;
  S.curItemId = null;
  // Mientras el reproductor carga, la API de YouTube todavía no tiene destroy(): fallaba en silencio y el iframe viejo quedaba
  // apilado encima del nuevo (controles que no responden, audio doble). Por eso, además, se saca del DOM a mano todo lo que haya.
  try { if (old && old.destroy) old.destroy(); } catch {}
  document.querySelectorAll('.player-wrap > iframe, .player-wrap > #player').forEach((n) => n.remove());
  $('.player-wrap').prepend(el('div', { id: 'player' }));
  initPlayer();
}

/** Quien controla la sala adelanta el video con los controles/teclado de YouTube (flechas, "Saltar adelante"): se avisa a la sala.
 *  Solo hacia adelante: un retroceso se confundiría con el lag de una pausa por buffering y atrasaría a todos. */
function checkJump() {
  if (!S.playerReady || !S.room || !S.room.current || !S.room.playing || !S.nativeControls || !canControl()) return;
  if (S.curItemId !== S.room.current.id || !isFinite(S.bestRtt)) return;
  const now = Date.now();
  if (now - S.syncOkAt < 6000 || now - S.lastJumpAt < 3000) return;
  let st, cur;
  try { st = S.player.getPlayerState(); cur = S.player.getCurrentTime(); } catch { return; }
  if (st !== 1) return;
  if (cur - targetPos() > 3) {
    S.lastJumpAt = now;
    S.lastSeekAt = now;
    send({ type: 'seek', pos: cur });
  }
}

/* ------------------------- agregar: links, playlists y búsqueda ------------------------- */
const looksLikeLink = (v) => /^(https?:\/\/|www\.|m\.youtube|music\.youtube|youtube\.com|youtu\.be)/i.test(v) || /^[\w-]{11}$/.test(v);

function parseListInfo(v) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v); } catch { return null; }
  const list = u.searchParams.get('list');
  if (!list || !/^[\w-]{10,64}$/.test(list)) return null;
  const hasVideo = !!u.searchParams.get('v') || /^\/(shorts|embed|live)\//.test(u.pathname) || (u.hostname === 'youtu.be' && u.pathname.length > 1);
  return { list, hasVideo, isMix: /^RD/.test(list) }; // los "Mix" automáticos no se pueden leer enteros
}

/** Lee los videos de una playlist con el propio reproductor de YouTube (sin API key ni cuota). */
function fetchPlaylistIds(listId) {
  return new Promise((resolve, reject) => {
    if (!S.ytReady || !window.YT || !YT.Player) return reject(new Error(t('add.ytNotReady')));
    const holder = el('div', { style: 'position:fixed;left:-9999px;top:0;width:220px;height:220px;overflow:hidden' });
    const inner = el('div');
    holder.append(inner);
    document.body.append(holder);
    let done = false;
    let p = null;
    let timer = null;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p && p.destroy(); } catch {}
      holder.remove();
      fn(val);
    };
    timer = setTimeout(() => finish(reject, new Error(t('add.listFail'))), 12000);
    p = new YT.Player(inner, {
      width: 220,
      height: 220,
      playerVars: { listType: 'playlist', list: listId, controls: 0, origin: location.origin },
      events: {
        onStateChange: (e) => {
          if (e.data !== 5 && e.data !== 1) return;
          let ids = [];
          try { ids = e.target.getPlaylist() || []; } catch {}
          if (ids.length) finish(resolve, ids);
        },
        onError: () => finish(reject, new Error(t('add.listFail2'))),
      },
    });
  });
}

async function addPlaylist(listId, next) {
  toast(t('add.reading'));
  try {
    const ids = await fetchPlaylistIds(listId);
    send({ type: 'addMany', ids: ids.slice(0, 50), next });
    if (ids.length > 50) toast(t('add.listTrunc', { n: ids.length }));
  } catch (e) {
    toast(e.message, 'error');
  }
}

const resultsBox = () => $('#search-results');
function hideResults() { resultsBox().classList.add('hidden'); resultsBox().replaceChildren(); }

function showPlaylistChoice(url, listId, next) {
  const box = resultsBox();
  box.classList.remove('hidden');
  box.replaceChildren(el('div', { class: 'choice' },
    el('div', { text: t('add.choice') }),
    el('div', { class: 'row' },
      el('button', { class: 'primary', text: t('add.onlyVideo'), onclick: () => { send({ type: 'add', url, next }); $('#add-url').value = ''; hideResults(); } }),
      el('button', { text: t('add.wholeList'), onclick: () => { addPlaylist(listId, next); $('#add-url').value = ''; hideResults(); } }),
      el('button', { class: 'ghost', text: t('add.cancel'), onclick: hideResults }),
    ),
  ));
}

async function runSearch(q) {
  const box = resultsBox();
  box.classList.remove('hidden');
  box.replaceChildren(el('div', { class: 'head', text: t('search.searching') }));
  let data;
  try {
    const headers = S.searchCode ? { 'X-Access-Code': S.searchCode } : {};
    data = await (await fetch('/api/search?q=' + encodeURIComponent(q), { cache: 'no-store', headers })).json();
  } catch {
    data = { error: 'failed' };
  }
  if (data.error === 'auth') {
    hideResults();
    S.searchCode = null;
    store.set('searchCode', null);
    S.pendingQuery = q;
    return openCodeDialog(t('search.err.auth'));
  }
  if (data.error) {
    hideResults();
    return toast(t('search.err.' + (['quota', 'rate', 'short', 'disabled'].includes(data.error) ? data.error : 'failed')), 'error');
  }
  box.replaceChildren(el('div', { class: 'head' }, el('span', { text: t('search.results', { q }) }), el('button', { class: 'mini ghost', text: t('search.close'), onclick: hideResults })));
  if (!data.results.length) box.append(el('div', { class: 'muted', text: t('search.none') }));
  for (const v of data.results) {
    const url = 'https://youtu.be/' + v.videoId;
    box.append(el('div', { class: 'item' },
      el('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/default.jpg`, alt: '', loading: 'lazy' }),
      el('div', { class: 't' }, el('div', { text: v.title }), el('div', { text: v.channel })),
      el('button', { class: 'mini', title: t('queue.addEnd'), text: t('queue.btnEnd'), onclick: () => { send({ type: 'add', url }); toast(t('search.added', { title: v.title })); } }),
      el('button', { class: 'mini', title: t('queue.addNext'), text: t('queue.btnNext'), onclick: () => { send({ type: 'add', url, next: true }); toast(t('search.addedNext', { title: v.title })); } }),
    ));
  }
}

function onAddSubmit(e) {
  e.preventDefault();
  const v = $('#add-url').value.trim();
  if (!v) return;
  const next = $('#add-where').value === 'next';
  hideResults();
  if (looksLikeLink(v)) {
    const li = parseListInfo(v);
    if (li && !li.isMix && !li.hasVideo) { $('#add-url').value = ''; return addPlaylist(li.list, next); }
    if (li && !li.isMix && li.hasVideo) return showPlaylistChoice(v, li.list, next);
    if (li && li.isMix && !li.hasVideo) return toast(t('add.mix'), 'error');
    send({ type: 'add', url: v, next });
    $('#add-url').value = '';
    return;
  }
  if (!S.searchEnabled) return toast(t('add.noSearch'), 'error');
  if (S.needsCode && !S.searchCode) {
    // quizá el dueño abrió el buscador a los invitados después de que cargué la página
    loadConfig().then(() => { if (S.needsCode && !S.searchCode) { S.pendingQuery = v; openCodeDialog(); } else runSearch(v); });
    return;
  }
  runSearch(v);
}

async function loadConfig() {
  try {
    const c = await (await fetch('/api/config', { cache: 'no-store' })).json();
    S.searchEnabled = !!c.search;
    S.needsCode = !!c.needsCode;
    S.ownerCanToggle = !!c.ownerCanToggle;
    S.guestsOpen = !!c.guestsOpen;
  } catch { S.searchEnabled = false; S.needsCode = false; }
  updateAddPlaceholder();
  $('#owner-search').classList.toggle('hidden', !S.ownerCanToggle);
  $('#set-guest-search').checked = !!S.guestsOpen;
  await applyHashKey();
}
/** Si llegó un código en el link (#k=...), lo valida y lo guarda como si lo hubiera escrito. */
async function applyHashKey() {
  const code = S.pendingHashKey;
  S.pendingHashKey = null;
  if (!code || !S.needsCode) return;
  let r = { ok: false };
  try { r = await (await fetch('/api/search-auth', { cache: 'no-store', headers: { 'X-Access-Code': code } })).json(); } catch {}
  if (!r.ok) return toast(t('access.bad'), 'error');
  S.searchCode = code;
  store.set('searchCode', code);
  updateAddPlaceholder();
  toast(t('access.good', { label: r.label || '' }));
}
function updateAddPlaceholder() {
  $('#add-url').placeholder = S.searchEnabled ? t('add.phSearch') : t('add.phLink');
  $('#btn-key').classList.toggle('hidden', !S.needsCode);
  $('#btn-key').classList.toggle('active', !!S.searchCode);
}

/* ---------------- código de acceso a la búsqueda ---------------- */
function openCodeDialog(msg) {
  const m = $('#access-msg');
  m.textContent = msg || '';
  m.classList.toggle('hidden', !msg);
  $('#access-code').value = '';
  $('#access-forget').classList.toggle('hidden', !S.searchCode);
  $('#access-copylink').classList.toggle('hidden', !S.searchCode);
  $('#code-dialog').showModal();
}
async function submitAccessCode() {
  const code = $('#access-code').value.trim();
  if (!code) return;
  let r = { ok: false };
  try { r = await (await fetch('/api/search-auth', { cache: 'no-store', headers: { 'X-Access-Code': code } })).json(); } catch {}
  if (!r.ok) {
    $('#access-msg').textContent = t('access.bad');
    $('#access-msg').classList.remove('hidden');
    return;
  }
  S.searchCode = code;
  store.set('searchCode', code);
  $('#code-dialog').close();
  updateAddPlaceholder();
  toast(t('access.good', { label: r.label || '' }));
  if (S.pendingQuery) { const q = S.pendingQuery; S.pendingQuery = null; runSearch(q); }
}

/* --------------------------------- lobby --------------------------------- */
function requireNick() {
  const v = $('#nick').value.replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!v) {
    toast(t('lobby.needNick'), 'error');
    $('#nick').focus();
    return null;
  }
  S.nick = v;
  store.set('nick', v);
  return v;
}

async function refreshPublicRooms() {
  if ($('#view-lobby').classList.contains('hidden')) return;
  const box = $('#public-rooms');
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    const list = await res.json();
    box.replaceChildren();
    if (!list.length) box.append(el('div', { class: 'empty', text: t('lobby.noPublic') }));
    for (const r of list) {
      box.append(el('div', { class: 'room-item' },
        el('div', { class: 'info' },
          el('div', { class: 'name', text: r.name }),
          el('div', { class: 'now', text: `👥 ${r.listeners}  ·  ${r.now ? (r.playing ? '▶ ' : '⏸ ') + r.now : t('lobby.noMusic')}` }),
        ),
        el('button', { class: 'primary', text: t('lobby.enter'), onclick: () => { if (requireNick()) connect({ action: 'join', code: r.code }); } }),
      ));
    }
  } catch { /* sin conexión: reintenta solo */ }
}

/* ------------------------------ temas / estilo --------------------------- */
function openThemeDialog() {
  const dlg = $('#theme-dialog');
  S.themeDraft = { ...effectiveTheme() };
  $('#use-mine').checked = S.useMine;
  $('#theme-apply-room').disabled = !canControl();
  $('#theme-help').textContent = canControl() ? t('theme.helpCtl') : t('theme.helpMember');
  syncColorInputs();
  $('#chat-color').dataset.on = '';
  $('#text-color').dataset.on = '';
  updateChatPreview();
  dlg.showModal();
}
function syncColorInputs() {
  document.querySelectorAll('#theme-dialog input[type=color][data-k]').forEach((i) => (i.value = S.themeDraft[i.dataset.k]));
  updateThemeWarning();
}
function updateThemeWarning() {
  const bad = !!S.themeDraft && lowContrast(S.themeDraft);
  $('#theme-warn').classList.toggle('hidden', !bad);
  $('#theme-apply-room').disabled = !canControl() || bad;
}
function updateChatPreview() {
  const panel = (S.themeDraft || effectiveTheme()).panel;
  const nickIn = $('#chat-color');
  const textIn = $('#text-color');
  const nick = S.nick || '…';
  const nc = fitColor(nickIn.dataset.on === '1' ? nickIn.value : S.chatColor, panel) || nickColor(nick);
  const tcol = fitColor(textIn.dataset.on === '1' ? textIn.value : S.textColor, panel);
  $('#cp-nick').textContent = nick;
  $('#cp-nick').style.color = nc;
  $('#cp-text').style.color = tcol || '';
}
function closeThemeDialog() {
  $('#theme-dialog').close();
}

function buildThemeDialog() {
  const box = $('#presets');
  for (const [name, t] of Object.entries(PRESETS)) {
    box.append(el('button', { class: 'preset', onclick: () => { S.themeDraft = { ...t }; syncColorInputs(); applyTheme(S.themeDraft); } },
      el('i', { style: `background:linear-gradient(135deg,${t.accent},${t.accent2})` }), document.createTextNode(name)));
  }
  document.querySelectorAll('#theme-dialog input[type=color][data-k]').forEach((i) => {
    i.addEventListener('input', () => { S.themeDraft[i.dataset.k] = i.value; applyTheme(S.themeDraft); updateThemeWarning(); });
  });
  $('#use-mine').addEventListener('change', (e) => {
    S.useMine = e.target.checked;
    store.set('useMine', S.useMine);
    if (S.useMine && !S.myTheme) { S.myTheme = { ...S.themeDraft }; store.set('theme', S.myTheme); }
    S.themeDraft = { ...effectiveTheme() };
    syncColorInputs();
    applyTheme(S.themeDraft);
  });
  $('#theme-apply-room').addEventListener('click', () => {
    S.sentThemeAt = Date.now();
    send({ type: 'theme', theme: S.themeDraft });
    toast(t('theme.applied'));
    S.themeDraft = null;
    closeThemeDialog();
  });
  $('#theme-save-mine').addEventListener('click', () => {
    S.myTheme = { ...S.themeDraft };
    store.set('theme', S.myTheme);
    S.useMine = true;
    store.set('useMine', true);
    $('#use-mine').checked = true;
    toast(t('theme.savedMine'));
  });
  $('#theme-close').addEventListener('click', closeThemeDialog);
  $('#theme-dialog').addEventListener('close', () => {
    S.themeDraft = null;
    applyTheme(effectiveTheme());
  });
}

/* --------------------------------- init ---------------------------------- */
function init() {
  applyStaticI18n();
  $('#nick').value = S.nick;
  buildThemeDialog();
  buildEmoteUi();
  document.querySelectorAll('.lang-sel').forEach((sel) => sel.addEventListener('change', () => setLanguage(sel.value)));

  // link de invitación: /#CODIGO  (y opcional /#k=MI-CODIGO-DE-BUSQUEDA, o /#CODIGO&k=...)
  // El navegador guarda el código por dirección: con el túnel rápido la dirección cambia cada día, así que este link lo vuelve a cargar.
  const hashParts = location.hash.replace('#', '').split('&').filter(Boolean);
  const hashKey = (hashParts.find((x) => x.startsWith('k=')) || '').slice(2);
  const h = (hashParts.find((x) => !x.includes('=')) || '').toUpperCase();
  if (/^[A-Z0-9]{4,8}$/.test(h)) {
    $('#join-code').value = h;
    toast(t('lobby.invited'));
  }
  if (hashKey) {
    try { history.replaceState(null, '', location.pathname + (h ? '#' + h : '')); } catch {} // el código no queda a la vista en la barra
    S.pendingHashKey = decodeURIComponent(hashKey);
  }

  $('#btn-create').addEventListener('click', () => {
    if (!requireNick()) return;
    connect({ action: 'create', name: $('#room-name').value, isPublic: $('#room-public').checked });
  });
  $('#btn-join').addEventListener('click', () => {
    if (!requireNick()) return;
    const code = $('#join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return toast(t('lobby.needCode'), 'error');
    connect({ action: 'join', code });
  });
  $('#join-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btn-join').click());
  $('#nick').addEventListener('keydown', (e) => e.key === 'Enter' && ($('#join-code').value ? $('#btn-join') : $('#btn-create')).click());

  $('#btn-leave').addEventListener('click', () => { send({ type: 'leave' }); backToLobby(); });
  $('#btn-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(S.room.code); toast(t('room.codeCopied', { code: S.room.code })); }
    catch { toast(t('room.codeShow', { code: S.room.code })); }
  });
  $('#btn-link').addEventListener('click', async () => {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      return toast(t('room.localhost'), 'error');
    }
    const link = `${location.origin}/#${S.room.code}`;
    try { await navigator.clipboard.writeText(link); toast(t('room.linkCopied')); }
    catch { toast(t('room.linkShow', { link })); }
  });
  $('#btn-fs').addEventListener('click', () => {
    const root = $('#fs-root');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => toast(t('room.fsDenied'), 'error'));
  });
  const applyFsChat = () => $('#fs-root').classList.toggle('nochat', !S.fsChat);
  applyFsChat();
  const toggleFsChat = () => { S.fsChat = !S.fsChat; store.set('fsChat', S.fsChat); applyFsChat(); };
  $('#btn-fs-chat').addEventListener('click', toggleFsChat);
  $('#fs-chat-tab').addEventListener('click', toggleFsChat);
  // el teclado de YouTube necesita el foco en el video: al pasar el mouse se lo damos (salvo que estés escribiendo)
  $('.player-wrap').addEventListener('mouseenter', () => {
    if (!S.kbOn) return;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    const f = $('#player');
    if (f && f.tagName === 'IFRAME') { try { f.focus(); } catch {} }
  });
  $('#fs-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#fs-chat-input').value.trim();
    if (!v) return;
    send({ type: 'chat', text: v });
    $('#fs-chat-input').value = '';
  });
  $('#btn-theme').addEventListener('click', openThemeDialog);
  $('#btn-settings').addEventListener('click', () => { $('#set-everyone').checked = !!S.room.settings.everyoneQueue; $('#settings-dialog').showModal(); });
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  $('#set-guest-search').addEventListener('change', async (e) => {
    const want = e.target.checked;
    let r = { ok: false };
    try { r = await (await fetch('/api/search-open?open=' + (want ? 1 : 0), { method: 'POST', cache: 'no-store' })).json(); } catch {}
    if (!r.ok) { e.target.checked = !want; return toast(t('settings.guestSearchFail'), 'error'); }
    S.guestsOpen = r.guestsOpen;
    toast(t(r.guestsOpen ? 'settings.guestSearchOn' : 'settings.guestSearchOff'));
  });
  $('#btn-settings').addEventListener('click', () => loadConfig());
  $('#set-everyone').addEventListener('change', (e) => send({ type: 'settings', everyoneQueue: e.target.checked }));

  $('#add-form').addEventListener('submit', onAddSubmit);
  $('#btn-yt').addEventListener('click', () => setNativeControls(!S.nativeControls));
  applyNativeControlsUi();
  const cc = $('#chat-color');
  const tc = $('#text-color');
  if (S.chatColor) cc.value = S.chatColor;
  if (S.textColor) tc.value = S.textColor;
  cc.addEventListener('input', () => { cc.dataset.on = '1'; updateChatPreview(); });
  tc.addEventListener('input', () => { tc.dataset.on = '1'; updateChatPreview(); });
  cc.addEventListener('change', () => {
    S.chatColor = cc.value;
    store.set('chatColor', S.chatColor);
    send({ type: 'setColor', color: S.chatColor });
    updateChatPreview();
  });
  tc.addEventListener('change', () => {
    S.textColor = tc.value;
    store.set('textColor', S.textColor);
    send({ type: 'setColor', tcolor: S.textColor });
    updateChatPreview();
  });
  $('#chat-color-auto').addEventListener('click', () => {
    S.chatColor = null;
    store.set('chatColor', null);
    send({ type: 'setColor', color: null });
    $('#chat-color').dataset.on = '';
    updateChatPreview();
    toast(t('chat.autoDone'));
  });
  $('#text-color-auto').addEventListener('click', () => {
    S.textColor = null;
    store.set('textColor', null);
    send({ type: 'setColor', tcolor: null });
    $('#text-color').dataset.on = '';
    updateChatPreview();
    toast(t('chat.autoTextDone'));
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#chat-input').value.trim();
    if (!v) return;
    send({ type: 'chat', text: v });
    $('#chat-input').value = '';
  });

  $('#btn-playpause').addEventListener('click', () => send({ type: S.room.playing ? 'pause' : 'play' }));
  $('#btn-next').addEventListener('click', () => send({ type: 'next' }));
  const seek = $('#seek');
  seek.addEventListener('pointerdown', () => (S.seeking = true));
  seek.addEventListener('change', () => {
    S.seeking = false;
    let dur = 0;
    try { dur = S.player.getDuration() || 0; } catch {}
    if (dur) send({ type: 'seek', pos: (seek.value / 1000) * dur });
  });
  seek.addEventListener('pointerup', () => setTimeout(() => (S.seeking = false), 300));

  const vol = $('#vol');
  vol.value = S.volume;
  vol.addEventListener('input', () => {
    S.volume = Number(vol.value);
    store.set('vol', S.volume);
    if (S.playerReady) S.player.setVolume(S.volume);
  });
  $('#unlock').addEventListener('click', () => {
    if (!S.playerReady) return;
    S.player.playVideo();
    S.stuck = 0;
    $('#unlock').classList.add('hidden');
    setTimeout(syncPlayer, 400);
  });

  setInterval(syncPlayer, 2000);
  setInterval(updateProgress, 500);
  setInterval(checkJump, 500);
  setInterval(refreshPublicRooms, 5000);
  document.addEventListener('visibilitychange', () => !document.hidden && syncPlayer());
  window.addEventListener('beforeunload', () => { S.closing = true; });

  refreshPublicRooms();
  loadConfig();
}

init();
