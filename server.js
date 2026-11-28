'use strict';
/**
 * Sincro Music - servidor
 * Salas en memoria (sin base de datos, sin cuentas). Se sincroniza el ESTADO
 * (qué video, en qué segundo, play/pausa), no el audio: cada persona lo
 * reproduce en su propio navegador con el reproductor oficial de YouTube.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// Carga opcional de un archivo ".env" (CLAVE=valor por línea) sin dependencias.
// Las variables que ya existan en el entorno tienen prioridad.
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const v = m[2].replace(/^(["'])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
} catch (e) { console.warn('No se pudo leer .env:', e.message); }

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GRACE_MS = Number(process.env.GRACE_MS) || 20000; // tiempo para reconectar sin perder el rol

const LIMITS = {
  rooms: 300,
  members: 30,
  queue: 100,
  nick: 20,
  roomName: 40,
  chatLen: 300,
  chatHistory: 60,
  history: 40, // canciones recordadas en el historial de la sala
  emotes: 25, // emotes personalizados por sala
  createsPerIp: 6, // por 10 minutos
  connsPerIp: 25,
};

const EMOTE_MAX_BYTES = 40 * 1024; // por imagen PNG (el navegador la achica antes de subirla)
const GIF_MAX_BYTES = 300 * 1024; // por GIF animado (se sube tal cual, no se puede achicar sin perder la animación)
const GIF_MAX_SIDE = 512; // px de lado máximo de un GIF
const PACKS_DIR = path.join(__dirname, 'packs', 'emotes'); // emotes que se cargan solos en cada sala nueva
const EMOTE_TOTAL_MAX = 48 * 1024 * 1024; // tope de memoria para todos los emotes juntos
let emoteBytesTotal = 0;
const EMOJIS = ['🔥', '❤️', '😂', '💀', '👏', '😭', '🤯', '👎'];
const THEME_KEYS = ['bg', 'panel', 'text', 'accent', 'accent2'];
const DEFAULT_THEME = { bg: '#0f1117', panel: '#181b24', text: '#e8eaf0', accent: '#7c5cff', accent2: '#ff5c8a' };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** @type {Map<string, any>} */
const rooms = new Map();
const ipConns = new Map();
const ipCreates = new Map();

/* ------------------------------ utilidades ------------------------------ */

const uid = () => crypto.randomBytes(6).toString('hex');

function genCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    const bytes = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseVideoId(input) {
  input = String(input || '').trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0];
  } else if (['youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      id = m && m[2];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Consulta oEmbed (gratis, sin API key). Devuelve título y si se puede embeber. */
async function lookupVideo(videoId) {
  const url =
    'https://www.youtube.com/oembed?format=json&url=' +
    encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 401) return { ok: false, reason: 'noEmbed' };
    if (res.status === 404 || res.status === 400) return { ok: false, reason: 'notFound' };
    if (!res.ok) return { ok: true, title: null };
    const j = await res.json();
    return { ok: true, title: cleanText(j.title, 120) || null };
  } catch {
    return { ok: true, title: null }; // si falla la consulta, no bloqueamos: el reproductor avisará si no anda
  } finally {
    clearTimeout(timer);
  }
}

/** Corre fn sobre cada elemento con como máximo n tareas a la vez, conservando el orden. */
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, arr.length) }, async () => {
      while (i < arr.length) {
        const k = i++;
        out[k] = await fn(arr[k]);
      }
    }),
  );
  return out;
}

const decodeEntities = (t) =>
  String(t || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/* ---- Búsqueda (opcional): usa la YouTube Data API con la key del servidor ---- */
const SEARCH = {
  dailyMax: Number(process.env.SEARCH_DAILY_MAX) || 90, // la cuota gratis es ~100 búsquedas/día para TODA la app
  perIpPerMin: 12,
  cacheMs: 24 * 3600 * 1000,
  cacheMax: 500,
};
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
let codesCache = { raw: null, map: new Map() };
/** SEARCH_ACCESS_CODES="ana:codigo1,beto:codigo2" → Map(hash del código → nombre). Cada código se puede revocar sacándolo de la lista. */
function accessCodes() {
  const raw = process.env.SEARCH_ACCESS_CODES || '';
  if (codesCache.raw === raw) return codesCache.map;
  const map = new Map();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(':');
    const label = i > 0 ? p.slice(0, i).trim() : p.slice(0, 3) + '…';
    const code = i > 0 ? p.slice(i + 1).trim() : p;
    if (code.length < 8) { console.warn(`SEARCH_ACCESS_CODES: el código de "${label}" es muy corto (mínimo 8 caracteres) y se ignora.`); continue; }
    map.set(sha(code), label);
  }
  codesCache = { raw, map };
  return map;
}
/** 'off' (sin key o sin códigos), 'private' (solo con código) o 'public' (SEARCH_PUBLIC=1, para cuando la app sea global). */
let searchOpenForGuests = false; // interruptor del dueño (se apaga al reiniciar): abre el buscador sin código
function searchMode() {
  if (!process.env.YOUTUBE_API_KEY) return 'off';
  if (process.env.SEARCH_PUBLIC === '1' || searchOpenForGuests) return 'public';
  return accessCodes().size > 0 ? 'private' : 'off';
}
const codeLabel = (req) => {
  const c = String(req.headers['x-access-code'] || '').trim().slice(0, 100);
  return c ? accessCodes().get(sha(c)) || null : null;
};
/** ¿La petición viene directo del navegador de la misma PC donde corre el servidor (http://localhost:PUERTO)?
 *  Las que llegan por un túnel o proxy traen cabeceras de reenvío y el Host de la dirección pública, así que no cuentan.
 *  El dueño no necesita código de búsqueda. Se apaga con LOCAL_OWNER_SEARCH=0. */
function isLocalOwner(req) {
  if (process.env.LOCAL_OWNER_SEARCH === '0') return false;
  return isLocalRequest(req);
}
/** Igual que arriba pero sin depender de LOCAL_OWNER_SEARCH (para avisar la dirección pública del túnel). */
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
  const h = req.headers;
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['forwarded'] || h['cf-connecting-ip'] || h['cf-ray'] || h['x-real-ip']) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(h.host || ''));
}
const authFails = new Map();
const tooManyFails = (ip) => (authFails.get(ip) || []).filter((t) => Date.now() - t < 600000).length >= 10;
const noteFail = (ip) => authFails.set(ip, [...(authFails.get(ip) || []).filter((t) => Date.now() - t < 600000), Date.now()]);
const searchCache = new Map();
const ipSearch = new Map();
let searchBudget = { day: '', used: 0 };
const todayPT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // la cuota se reinicia a medianoche del Pacífico

async function searchVideos(q) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { error: 'disabled' };
  const norm = q.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
  if (norm.length < 2) return { error: 'short' };
  const hit = searchCache.get(norm);
  if (hit && Date.now() - hit.t < SEARCH.cacheMs) return { results: hit.results, cached: true };
  const day = todayPT();
  if (searchBudget.day !== day) searchBudget = { day, used: 0 };
  if (searchBudget.used >= SEARCH.dailyMax) return { error: 'quota' };
  searchBudget.used++;
  const url =
    'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8' +
    `&q=${encodeURIComponent(norm)}&key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).error.errors[0].reason; } catch {}
      if (['quotaExceeded', 'rateLimitExceeded', 'dailyLimitExceeded'].includes(reason)) {
        searchBudget.used = SEARCH.dailyMax;
        return { error: 'quota' };
      }
      console.error('Búsqueda falló:', res.status, reason || '(sin detalle)'); // p. ej. keyInvalid / accessNotConfigured
      return { error: 'failed' };
    }
    const j = await res.json();
    const results = (j.items || [])
      .filter((i) => i.id && /^[\w-]{11}$/.test(i.id.videoId || ''))
      .map((i) => ({
        videoId: i.id.videoId,
        title: cleanText(decodeEntities(i.snippet && i.snippet.title), 120),
        channel: cleanText(decodeEntities(i.snippet && i.snippet.channelTitle), 60),
      }));
    searchCache.set(norm, { t: Date.now(), results });
    if (searchCache.size > SEARCH.cacheMax) searchCache.delete(searchCache.keys().next().value);
    return { results };
  } catch {
    return { error: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- dirección pública (para el botón "Link": desde localhost copia la del túnel, no "localhost") ----------
let publicUrl = '';
const cleanPublicUrl = (u) => {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return '';
    if (/^(localhost|127\.|\[::1\])/i.test(x.hostname)) return '';
    return x.origin;
  } catch { return ''; }
};
publicUrl = cleanPublicUrl(process.env.PUBLIC_URL || '');

// ---------- playlists: se leen en el servidor (API de YouTube si hay clave; si no, la página pública) ----------
const playlistCache = new Map();
const ipPlaylist = new Map();
/** Saca los ids de video (en orden, sin repetir) del HTML de una playlist de YouTube. */
function idsFromPlaylistHtml(html) {
  const out = [];
  const re = /"playlistVideoRenderer":\{"videoId":"([\w-]{11})"/g;
  let m;
  while ((m = re.exec(html)) && out.length < 100) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
async function playlistIds(list) {
  if (!/^[\w-]{10,64}$/.test(list) || /^RD/.test(list)) return { error: 'bad' };
  const hit = playlistCache.get(list);
  if (hit && Date.now() - hit.t < 10 * 60000) return { ids: hit.ids };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let ids = [];
  try {
    const key = process.env.YOUTUBE_API_KEY;
    if (key) {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(list)}&key=${encodeURIComponent(key)}`, { signal: ctrl.signal });
      if (r.ok) ids = ((await r.json()).items || []).map((i) => i.contentDetails && i.contentDetails.videoId).filter((v) => /^[\w-]{11}$/.test(v || ''));
      else console.warn('Playlist (API) falló:', r.status);
    }
    if (!ids.length) {
      const r = await fetch('https://www.youtube.com/playlist?list=' + encodeURIComponent(list), {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
      });
      if (r.ok) ids = idsFromPlaylistHtml(await r.text());
    }
  } catch { /* se informa abajo */ } finally { clearTimeout(timer); }
  if (!ids.length) return { error: 'failed' };
  playlistCache.set(list, { t: Date.now(), ids });
  if (playlistCache.size > 100) playlistCache.delete(playlistCache.keys().next().value);
  return { ids };
}

const cleanColor = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null);
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

function validTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of THEME_KEYS) {
    if (typeof t[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(t[k])) return null;
    out[k] = t[k].toLowerCase();
  }
  return out;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

/* --------------------------- estado de la sala --------------------------- */

const curPos = (r) => (r.playing ? r.basePos + (Date.now() - r.baseAt) / 1000 : r.basePos);

function pubItem(it) {
  return it && { id: it.id, videoId: it.videoId, title: it.title, by: it.by, titleUnknown: !!it.titleUnknown };
}

function snapshot(r) {
  return {
    code: r.code,
    name: r.name,
    isPublic: r.isPublic,
    settings: r.settings,
    theme: r.theme,
    members: [...r.members.values()].map((m) => ({ id: m.pid, nick: m.nick, color: m.color, tcolor: m.tcolor, role: m.role, online: m.connected })),
    queue: r.queue.map(pubItem),
    history: r.history,
    emotes: [...r.emotes.values()].map((e) => ({ name: e.name, v: e.v, by: e.by, ext: e.ext || 'png' })),
    current: pubItem(r.current),
    playing: r.playing,
    pos: curPos(r),
    at: Date.now(),
    reactions: r.reactions,
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
// los textos viven en el cliente (public/i18n.js): el servidor solo manda la clave del mensaje
const err = (ws, key, code) => send(ws, { type: 'error', key, code });

function broadcast(r, obj) {
  for (const m of r.members.values()) if (m.connected) send(m.ws, obj);
}

function pushRoom(r) {
  const snap = snapshot(r);
  for (const m of r.members.values()) if (m.connected) send(m.ws, { type: 'room', room: snap, you: m.pid });
}

function sysChat(r, key, params = {}) {
  const msg = { id: uid(), system: true, key, params, t: Date.now() };
  r.chat.push(msg);
  if (r.chat.length > LIMITS.chatHistory) r.chat.shift();
  broadcast(r, { type: 'chat', msg });
}

/** Anota la canción en el historial (la más reciente arriba, sin repetidas). */
function recordHistory(r, item) {
  r.history = r.history.filter((h) => h.videoId !== item.videoId);
  r.history.unshift({ id: uid(), videoId: item.videoId, title: item.title, by: item.by });
  if (r.history.length > LIMITS.history) r.history.length = LIMITS.history;
}

function newItem(videoId, title, by, titleUnknown = false) {
  return { id: uid(), videoId, title, titleUnknown, by, endVotes: new Set(), errVotes: new Set() };
}

function startTrack(r, item) {
  r.current = item;
  r.basePos = 0;
  r.baseAt = Date.now();
  r.playing = !!item;
  r.reactions = {};
  if (item) recordHistory(r, item);
}

function advance(r) {
  const next = r.queue.shift();
  if (next) startTrack(r, next);
  else startTrack(r, null);
}

const canControl = (m) => m.role === 'host' || m.role === 'admin';
const connectedCount = (r) => [...r.members.values()].filter((m) => m.connected).length;

function uniqueNick(r, nick, clientId) {
  const taken = new Set([...r.members.values()].filter((m) => m.clientId !== clientId).map((m) => m.nick.toLowerCase()));
  if (!taken.has(nick.toLowerCase())) return nick;
  for (let i = 2; i < 100; i++) {
    const cand = `${nick.slice(0, LIMITS.nick - 3)} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return nick;
}

function promoteNewHost(r) {
  const order = { admin: 0, member: 1 };
  const cand = [...r.members.values()]
    .filter((m) => m.role !== 'host')
    .sort((a, b) => (b.connected - a.connected) || (order[a.role] - order[b.role]) || (a.joinedAt - b.joinedAt))[0];
  if (cand) {
    cand.role = 'host';
    sysChat(r, 'newHost', { nick: cand.nick });
  }
}

function deleteRoom(r) {
  for (const e of r.emotes.values()) if (!e.shared) emoteBytesTotal -= e.buf.length;
  rooms.delete(r.code);
}

/** Valida que sea un PNG chico de verdad (firma + tamaño en la cabecera). Devuelve el Buffer o null. */
function parsePng(b64) {
  if (typeof b64 !== 'string' || b64.length > 60000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  return checkPng(buf);
}
function checkPng(buf) {
  if (buf.length < 33 || buf.length > EMOTE_MAX_BYTES) return null;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h || w > 256 || h > 256) return null;
  return buf;
}
/** Valida un GIF (firma GIF87a/GIF89a + tamaño de la cabecera). Devuelve el Buffer o null. */
function checkGif(buf) {
  if (buf.length < 14 || buf.length > GIF_MAX_BYTES) return null;
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  if (!w || !h || w > GIF_MAX_SIDE || h > GIF_MAX_SIDE) return null;
  return buf;
}
/** Emote que llega por WebSocket (base64). fmt: 'png' (por defecto) o 'gif'. Devuelve {buf, ext} o null. */
function parseEmote(b64, fmt) {
  if (fmt === 'gif') {
    if (typeof b64 !== 'string' || b64.length > Math.ceil(GIF_MAX_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    const buf = checkGif(Buffer.from(b64, 'base64'));
    return buf ? { buf, ext: 'gif' } : null;
  }
  const buf = parsePng(b64);
  return buf ? { buf, ext: 'png' } : null;
}

/** Carpeta packs/emotes: cada .png / .gif se carga solo en toda sala nueva (el nombre del archivo es el nombre del emote). */
const packEmotes = new Map();
function loadPackEmotes() {
  packEmotes.clear();
  let files = [];
  try { files = fs.readdirSync(PACKS_DIR).sort(); } catch { return; }
  for (const f of files) {
    const m = f.match(/^([a-z0-9_]{2,20})\.(png|gif)$/i);
    if (!m || packEmotes.size >= LIMITS.emotes) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(PACKS_DIR, f)); } catch { continue; }
    const ext = m[2].toLowerCase();
    const ok = ext === 'gif' ? checkGif(buf) : checkPng(buf);
    if (!ok) { console.warn(`packs/emotes/${f}: no es un ${ext.toUpperCase()} válido o es muy pesado/grande (se ignora).`); continue; }
    const name = m[1].toLowerCase();
    packEmotes.set(name, { name, buf, ext, v: 'p' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 8), by: 'pack', shared: true });
  }
  if (packEmotes.size) console.log(`Emotes de la carpeta packs: ${packEmotes.size} (${[...packEmotes.keys()].join(', ')})`);
}
loadPackEmotes();

function removeMember(r, clientId, mode) {
  const m = r.members.get(clientId);
  if (!m) return;
  clearTimeout(m.timer);
  r.members.delete(clientId);
  if (r.members.size === 0) {
    deleteRoom(r);
    return;
  }
  if (m.role === 'host') promoteNewHost(r);
  if (mode !== false) sysChat(r, mode === 'kicked' ? 'kicked' : 'left', { nick: m.nick });
  pushRoom(r);
}

function addMember(r, ws, clientId, nick, color, tcolor) {
  const m = {
    pid: uid(),
    clientId,
    nick: uniqueNick(r, nick, clientId),
    color: color || null,
    tcolor: tcolor || null,
    role: r.members.size === 0 ? 'host' : 'member',
    joinedAt: Date.now(),
    connected: true,
    ws,
    timer: null,
  };
  r.members.set(clientId, m);
  return m;
}

function attach(ws, r, clientId) {
  ws.ctx = { code: r.code, clientId };
}

/* ------------------------------- mensajes ------------------------------- */

function allow(ws, cost = 1) {
  const now = Date.now();
  ws.tokens = Math.min(30, (ws.tokens ?? 30) + ((now - (ws.tAt || now)) / 1000) * 6);
  ws.tAt = now;
  if (ws.tokens < cost) return false;
  ws.tokens -= cost;
  return true;
}

async function handle(ws, msg, ip) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t, s: Date.now() });

  if (!allow(ws, msg.type === 'addEmote' ? 8 : msg.type === 'chat' || msg.type === 'addMany' ? 3 : msg.type === 'react' ? 2 : 1)) return;

  /* ---- entrar / crear ---- */
  if (msg.type === 'create' || msg.type === 'join') {
    if (ws.ctx) return;
    const clientId = String(msg.clientId || '');
    if (!/^[\w-]{8,64}$/.test(clientId)) return err(ws, 'badId', 'bad');
    const nick = cleanText(msg.nick, LIMITS.nick);
    if (!nick) return err(ws, 'needNick', 'nick');

    if (msg.type === 'create') {
      const now = Date.now();
      const recent = (ipCreates.get(ip) || []).filter((t) => now - t < 600000);
      if (recent.length >= LIMITS.createsPerIp) return err(ws, 'createRate', 'rate');
      if (rooms.size >= LIMITS.rooms) return err(ws, 'tooManyRooms', 'full');
      const code = genCode();
      if (!code) return err(ws, 'codeFail', 'bad');
      recent.push(now);
      ipCreates.set(ip, recent);
      const r = {
        code,
        name: cleanText(msg.name, LIMITS.roomName) || `Sala de ${nick}`,
        isPublic: !!msg.public,
        createdAt: now,
        members: new Map(),
        banned: new Set(),
        queue: [],
        history: [],
        emotes: new Map([...packEmotes].map(([k, e]) => [k, e])), // los de packs/emotes vienen ya cargados
        current: null,
        playing: false,
        basePos: 0,
        baseAt: now,
        reactions: {},
        chat: [],
        theme: { ...DEFAULT_THEME },
        settings: { everyoneQueue: false, everyoneEmotes: false },
      };
      rooms.set(code, r);
      addMember(r, ws, clientId, nick, cleanColor(msg.color), cleanColor(msg.tcolor));
      attach(ws, r, clientId);
      send(ws, { type: 'history', chat: r.chat });
      pushRoom(r);
      return;
    }

    // join
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = rooms.get(code);
    if (!r) return err(ws, 'noRoom', 'notfound');
    if (r.banned.has(clientId)) return err(ws, 'banned', 'banned');
    let m = r.members.get(clientId);
    let isNew = false;
    if (m) {
      // reconexión (refresh, corte de internet, otra pestaña)
      if (m.ws && m.ws !== ws) {
        m.ws.replaced = true;
        try { m.ws.close(4000, 'replaced'); } catch {}
      }
      clearTimeout(m.timer);
      m.ws = ws;
      m.connected = true;
      if (msg.color !== undefined) m.color = cleanColor(msg.color);
      if (msg.tcolor !== undefined) m.tcolor = cleanColor(msg.tcolor);
    } else {
      if (r.members.size >= LIMITS.members) return err(ws, 'roomFull', 'full');
      m = addMember(r, ws, clientId, nick, cleanColor(msg.color), cleanColor(msg.tcolor));
      isNew = true;
    }
    attach(ws, r, clientId);
    send(ws, { type: 'history', chat: r.chat });
    if (isNew) sysChat(r, 'joined', { nick: m.nick });
    pushRoom(r);
    return;
  }

  /* ---- ya dentro de una sala ---- */
  const ctx = ws.ctx;
  if (!ctx) return err(ws, 'joinFirst', 'bad');
  const r = rooms.get(ctx.code);
  if (!r) return;
  const me = r.members.get(ctx.clientId);
  if (!me || me.ws !== ws) return;
  const byPid = (pid) => [...r.members.values()].find((x) => x.pid === pid);

  switch (msg.type) {
    case 'leave':
      ws.left = true;
      removeMember(r, ctx.clientId);
      ws.ctx = null;
      return;

    case 'chat': {
      const text = cleanText(msg.text, LIMITS.chatLen);
      if (!text) return;
      const m = { id: uid(), pid: me.pid, nick: me.nick, color: me.color, tcolor: me.tcolor, text, t: Date.now() };
      r.chat.push(m);
      if (r.chat.length > LIMITS.chatHistory) r.chat.shift();
      return broadcast(r, { type: 'chat', msg: m });
    }

    case 'setColor':
      if (msg.color !== undefined) me.color = cleanColor(msg.color);
      if (msg.tcolor !== undefined) me.tcolor = cleanColor(msg.tcolor);
      return pushRoom(r);

    case 'react': {
      // reacciones: los emojis de la lista o un emote personalizado de la sala (:nombre:)
      const em = typeof msg.emoji === 'string' && msg.emoji.match(/^:([a-z0-9_]{2,20}):$/);
      if (!EMOJIS.includes(msg.emoji) && !(em && r.emotes.has(em[1]))) return;
      if (r.current) r.reactions[msg.emoji] = (r.reactions[msg.emoji] || 0) + 1;
      return broadcast(r, { type: 'reaction', emoji: msg.emoji, nick: me.nick, counts: r.reactions });
    }

    case 'add': {
      if (!canControl(me) && !r.settings.everyoneQueue) return err(ws, 'queuePerm', 'perm');
      if (r.queue.length >= LIMITS.queue) return err(ws, 'queueFull', 'full');
      const videoId = parseVideoId(msg.url);
      if (!videoId) return err(ws, 'badLink', 'bad');
      const info = await lookupVideo(videoId);
      if (!info.ok) return err(ws, info.reason, 'video');
      if (!rooms.has(r.code) || !r.members.has(ctx.clientId)) return;
      if (r.queue.length >= LIMITS.queue) return;
      const item = {
        id: uid(),
        videoId,
        title: info.title || `Video ${videoId}`,
        titleUnknown: !info.title,
        by: me.nick,
        endVotes: new Set(),
        errVotes: new Set(),
      };
      if (!r.current) startTrack(r, item);
      else if (msg.next) r.queue.unshift(item); // "siguiente": va primera en la cola
      else r.queue.push(item);
      pushRoom(r);
      return;
    }

    case 'addMany': {
      if (!canControl(me) && !r.settings.everyoneQueue) return err(ws, 'queuePerm', 'perm');
      const ids = [...new Set((Array.isArray(msg.ids) ? msg.ids : []).filter((x) => typeof x === 'string' && /^[\w-]{11}$/.test(x)))].slice(0, 50);
      if (!ids.length) return err(ws, 'noVideos', 'bad');
      if (r.queue.length >= LIMITS.queue) return err(ws, 'queueFull', 'full');
      const infos = await mapLimit(ids, 5, lookupVideo);
      if (!rooms.has(r.code) || !r.members.has(ctx.clientId)) return;
      let skipped = 0;
      let items = [];
      ids.forEach((id, i) => {
        if (!infos[i].ok) { skipped++; return; }
        items.push(newItem(id, infos[i].title || `Video ${id}`, me.nick, !infos[i].title));
      });
      items = items.slice(0, Math.max(0, LIMITS.queue - r.queue.length));
      if (!items.length) return err(ws, 'noneAdded', 'video');
      const total = items.length;
      if (!r.current) startTrack(r, items.shift());
      if (msg.next) r.queue.unshift(...items);
      else r.queue.push(...items);
      sysChat(r, 'playlist', { nick: me.nick, total, skipped });
      return pushRoom(r);
    }

    case 'addEmote': {
      if (!canControl(me) && !r.settings.everyoneEmotes) return err(ws, 'emotePerm', 'perm');
      const name = String(msg.name || '').toLowerCase();
      if (!/^[a-z0-9_]{2,20}$/.test(name)) return err(ws, 'emoteName', 'bad');
      const parsed = parseEmote(msg.data, msg.fmt === 'gif' ? 'gif' : 'png');
      if (!parsed) return err(ws, 'emoteImage', 'bad');
      const buf = parsed.buf;
      const old = r.emotes.get(name);
      const oldBytes = old && !old.shared ? old.buf.length : 0;
      if (!old && r.emotes.size >= LIMITS.emotes) return err(ws, 'emoteLimit', 'full');
      if (emoteBytesTotal - oldBytes + buf.length > EMOTE_TOTAL_MAX) return err(ws, 'emoteLimit', 'full');
      emoteBytesTotal += buf.length - oldBytes;
      r.emotes.set(name, { name, buf, ext: parsed.ext, v: uid(), by: me.nick });
      sysChat(r, 'emoteAdded', { nick: me.nick, name });
      return pushRoom(r);
    }

    case 'removeEmote': {
      if (!canControl(me)) return err(ws, 'ctlPerm', 'perm');
      const e = r.emotes.get(String(msg.name || ''));
      if (!e) return;
      if (!e.shared) emoteBytesTotal -= e.buf.length;
      r.emotes.delete(e.name);
      delete r.reactions[':' + e.name + ':'];
      return pushRoom(r);
    }

    case 'setTitle': {
      const it = r.current;
      if (it && it.id === msg.itemId && it.titleUnknown) {
        const t = cleanText(msg.title, 120);
        if (t) {
          it.title = t;
          it.titleUnknown = false;
          const h = r.history.find((x) => x.videoId === it.videoId);
          if (h) h.title = t;
          pushRoom(r);
        }
      }
      return;
    }

    case 'queueFromHistory': {
      if (!canControl(me) && !r.settings.everyoneQueue) return err(ws, 'queuePerm', 'perm');
      if (r.queue.length >= LIMITS.queue) return err(ws, 'queueFull', 'full');
      const h = r.history.find((x) => x.id === msg.itemId);
      if (!h) return;
      const item = newItem(h.videoId, h.title, h.by);
      if (!r.current) startTrack(r, item);
      else if (msg.next) r.queue.unshift(item);
      else r.queue.push(item);
      return pushRoom(r);
    }

    case 'ended':
    case 'trackError': {
      const it = r.current;
      if (!it || it.id !== msg.itemId) return;
      if (Date.now() - r.baseAt < 2500 && msg.type === 'ended') return; // evita saltos por reportes viejos
      const votes = msg.type === 'ended' ? it.endVotes : it.errVotes;
      votes.add(me.pid);
      const enough = canControl(me) || votes.size >= Math.ceil(connectedCount(r) / 2);
      if (!enough) return;
      if (msg.type === 'trackError') sysChat(r, 'trackError', { title: it.title });
      advance(r);
      return pushRoom(r);
    }
  }

  /* ---- acciones solo para host / admins ---- */
  if (['play', 'pause', 'seek', 'next', 'remove', 'clear', 'move', 'playNow', 'playFromHistory', 'theme'].includes(msg.type)) {
    if (!canControl(me)) return err(ws, 'ctlPerm', 'perm');
    switch (msg.type) {
      case 'play':
        if (r.current && !r.playing) {
          r.playing = true;
          r.baseAt = Date.now();
        }
        break;
      case 'pause':
        if (r.current && r.playing) {
          r.basePos = curPos(r);
          r.playing = false;
        }
        break;
      case 'seek': {
        const p = Number(msg.pos);
        if (!r.current || !Number.isFinite(p) || p < 0 || p > 60 * 60 * 12) return;
        r.basePos = p;
        r.baseAt = Date.now();
        break;
      }
      case 'next':
        if (!r.current) return;
        advance(r);
        break;
      case 'remove':
        r.queue = r.queue.filter((x) => x.id !== msg.itemId);
        break;
      case 'clear':
        r.queue = [];
        break;
      case 'move': {
        // index = posición final que tendrá la canción dentro de la cola
        const from = r.queue.findIndex((x) => x.id === msg.itemId);
        const to = Math.trunc(Number(msg.index));
        if (from < 0 || !Number.isFinite(to)) return;
        const [it] = r.queue.splice(from, 1);
        r.queue.splice(Math.max(0, Math.min(to, r.queue.length)), 0, it);
        break;
      }
      case 'playNow': {
        const i = r.queue.findIndex((x) => x.id === msg.itemId);
        if (i < 0) return;
        const [it] = r.queue.splice(i, 1);
        startTrack(r, it);
        break;
      }
      case 'playFromHistory': {
        const h = r.history.find((x) => x.id === msg.itemId);
        if (!h) return;
        startTrack(r, newItem(h.videoId, h.title, h.by));
        break;
      }
      case 'theme': {
        const t = validTheme(msg.theme);
        if (!t) return err(ws, 'badColors', 'bad');
        if (contrast(t.text, t.bg) < 3 || contrast(t.text, t.panel) < 3) {
          return err(ws, 'contrast', 'contrast');
        }
        r.theme = t;
        break;
      }
    }
    return pushRoom(r);
  }

  /* ---- gestión de la sala ---- */
  switch (msg.type) {
    case 'settings':
      if (me.role !== 'host') return err(ws, 'hostOnly', 'perm');
      if (msg.everyoneQueue !== undefined) r.settings.everyoneQueue = !!msg.everyoneQueue;
      if (msg.everyoneEmotes !== undefined) r.settings.everyoneEmotes = !!msg.everyoneEmotes;
      return pushRoom(r);

    case 'setRole': {
      if (me.role !== 'host') return err(ws, 'hostOnlyAdmin', 'perm');
      const t = byPid(msg.target);
      if (!t || t.role === 'host') return;
      t.role = msg.admin ? 'admin' : 'member';
      sysChat(r, msg.admin ? 'nowAdmin' : 'noAdmin', { nick: t.nick });
      return pushRoom(r);
    }

    case 'transferHost': {
      if (me.role !== 'host') return err(ws, 'hostOnlyTransfer', 'perm');
      const t = byPid(msg.target);
      if (!t || t === me) return;
      t.role = 'host';
      me.role = 'admin';
      sysChat(r, 'newHost', { nick: t.nick });
      return pushRoom(r);
    }

    case 'kick': {
      const t = byPid(msg.target);
      if (!t || t === me) return;
      if (t.role === 'host') return err(ws, 'kickHost', 'perm');
      if (me.role === 'admin' && t.role !== 'member') return err(ws, 'kickAdmin', 'perm');
      if (me.role === 'member') return err(ws, 'kickPerm', 'perm');
      r.banned.add(t.clientId);
      if (t.ws) {
        t.ws.kicked = true;
        send(t.ws, { type: 'kicked' });
        try { t.ws.close(4001, 'kicked'); } catch {}
      }
      removeMember(r, t.clientId, 'kicked');
      return;
    }
  }
}

/* ------------------------------ HTTP + WS ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // YouTube necesita que el embed reciba el origen (Referer) para funcionar bien
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (url.pathname === '/api/rooms') {
    const list = [...rooms.values()]
      .filter((r) => r.isPublic && connectedCount(r) > 0)
      .map((r) => ({
        code: r.code,
        name: r.name,
        listeners: connectedCount(r),
        now: r.current ? r.current.title : null,
        playing: r.playing,
      }))
      .sort((a, b) => b.listeners - a.listeners)
      .slice(0, 100);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(list));
    return;
  }
  const em = url.pathname.match(/^\/emote\/([A-Z0-9]{4,8})\/([a-z0-9_]{2,20})\.(png|gif)$/);
  if (em) {
    const room = rooms.get(em[1]);
    const e = room && room.emotes.get(em[2]);
    if (!e) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': e.ext === 'gif' ? 'image/gif' : 'image/png', 'Content-Length': e.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(e.buf);
    return;
  }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const mode = searchMode();
    res.end(JSON.stringify({
      search: mode !== 'off',
      needsCode: mode === 'private' && !isLocalOwner(req),
      ownerCanToggle: !!process.env.YOUTUBE_API_KEY && process.env.SEARCH_PUBLIC !== '1' && isLocalOwner(req),
      guestsOpen: searchOpenForGuests,
      publicUrl,
    }));
    return;
  }
  if (url.pathname === '/api/search-open') {
    // solo el dueño (navegador en la misma PC, por localhost) puede abrir o cerrar el buscador a los invitados
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method !== 'POST' || !process.env.YOUTUBE_API_KEY || process.env.SEARCH_PUBLIC === '1' || !isLocalOwner(req)) return res.end(JSON.stringify({ ok: false }));
    searchOpenForGuests = url.searchParams.get('open') === '1';
    return res.end(JSON.stringify({ ok: true, guestsOpen: searchOpenForGuests }));
  }
  if (url.pathname === '/api/search-auth') {
    const ip = clientIp(req);
    const out = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (searchMode() !== 'private') return out({ ok: false });
    if (tooManyFails(ip)) return out({ ok: false, error: 'rate' });
    const label = codeLabel(req);
    if (!label) noteFail(ip);
    return out(label ? { ok: true, label } : { ok: false });
  }
  if (url.pathname === '/api/search') {
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const ip = clientIp(req);
    const mode = searchMode();
    if (mode === 'off') return json({ error: 'disabled' });
    let who = ip;
    if (mode === 'private' && isLocalOwner(req)) {
      who = 'owner';
    } else if (mode === 'private') {
      if (tooManyFails(ip)) return json({ error: 'rate' });
      const label = codeLabel(req);
      if (!label) {
        noteFail(ip);
        return json({ error: 'auth' });
      }
      who = 'code:' + label;
    }
    const now = Date.now();
    const recent = (ipSearch.get(who) || []).filter((t) => now - t < 60000);
    if (recent.length >= SEARCH.perIpPerMin) return json({ error: 'rate' });
    recent.push(now);
    ipSearch.set(who, recent);
    searchVideos(String(url.searchParams.get('q') || '')).then(json, () => json({ error: 'failed' }));
    return;
  }
  if (url.pathname === '/api/public-url') {
    // solo desde la misma PC (lo llama tunel.ps1 al abrir el túnel): guarda la dirección que hay que compartir
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method !== 'POST' || !isLocalRequest(req)) return res.end(JSON.stringify({ ok: false }));
    const u = cleanPublicUrl(url.searchParams.get('url') || '');
    if (!u) return res.end(JSON.stringify({ ok: false }));
    publicUrl = u;
    return res.end(JSON.stringify({ ok: true, url: publicUrl }));
  }
  if (url.pathname === '/api/playlist') {
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (ipPlaylist.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= 6) return json({ error: 'rate' });
    recent.push(now);
    ipPlaylist.set(ip, recent);
    playlistIds(String(url.searchParams.get('list') || '')).then(json, () => json({ error: 'failed' }));
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (e, data) => {
    if (e) {
      if (path.extname(rel)) {
        res.writeHead(404).end('not found');
        return;
      }
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) return res.writeHead(500).end('error');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(d2);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 }); // 8 KB para todo, salvo addEmote (imagen o GIF)

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const n = (ipConns.get(ip) || 0) + 1;
  if (n > LIMITS.connsPerIp) {
    ws.close(1013, 'too many connections');
    return;
  }
  ipConns.set(ip, n);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (data.length > 8192 && !(msg && msg.type === 'addEmote')) return;
    handle(ws, msg, ip).catch((e) => console.error('handler error', e));
  });

  ws.on('close', () => {
    const left = (ipConns.get(ip) || 1) - 1;
    if (left <= 0) ipConns.delete(ip);
    else ipConns.set(ip, left);

    const ctx = ws.ctx;
    if (!ctx || ws.replaced || ws.kicked || ws.left) return;
    const r = rooms.get(ctx.code);
    const m = r && r.members.get(ctx.clientId);
    if (!m || m.ws !== ws) return;
    m.connected = false;
    m.ws = null;
    pushRoom(r);
    m.timer = setTimeout(() => removeMember(r, ctx.clientId), GRACE_MS);
  });

  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Sincro Music escuchando en http://localhost:${PORT}`);
    if (process.env.YOUTUBE_API_KEY && searchMode() === 'off') {
      console.warn('Hay YOUTUBE_API_KEY pero no SEARCH_ACCESS_CODES: la búsqueda queda desactivada. Definí SEARCH_ACCESS_CODES="ana:codigo1,beto:codigo2" (o SEARCH_PUBLIC=1 para abrirla a todos).');
    }
  });
}

module.exports = { server, rooms, parseVideoId, parseEmote, idsFromPlaylistHtml, cleanPublicUrl, packEmotes, loadPackEmotes };
