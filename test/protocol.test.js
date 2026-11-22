'use strict';
// Prueba end-to-end del protocolo con varios clientes WebSocket reales.
process.env.GRACE_MS = '400';
process.env.YOUTUBE_API_KEY = 'test-key';
process.env.SEARCH_DAILY_MAX = '3';
process.env.LOCAL_OWNER_SEARCH = '0'; // los clientes de prueba son locales: se simula un visitante remoto salvo en el bloque "dueño"
process.env.SEARCH_ACCESS_CODES = 'ana:codigo-ana-123,beto:codigo-beto-456,corto:abc';
const assert = require('assert');
const WebSocket = require('ws');

// Simulamos oEmbed de YouTube para no depender de internet
let apiSearchCalls = 0;
global.fetch = async (url) => {
  if (String(url).includes('googleapis.com/youtube/v3/search')) {
    apiSearchCalls++;
    const q = new URL(url).searchParams.get('q');
    if (q === 'sin cupo') return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
    return { ok: true, status: 200, json: async () => ({ items: [
      { id: { videoId: 'sssssssss01' }, snippet: { title: 'Tom &amp; Jerry&#39;s &quot;mix&quot;', channelTitle: 'Canal &amp; Co' } },
      { id: { videoId: 'sssssssss02' }, snippet: { title: 'Resultado ' + q, channelTitle: 'Otro' } },
      { id: { kind: 'youtube#channel' }, snippet: { title: 'no es video' } },
    ] }) };
  }
  const id = decodeURIComponent(String(url)).match(/v=([\w-]{11})/)[1];
  if (id === 'BLOCKED_001') return { status: 401, ok: false };
  if (id === 'MISSING_001') return { status: 404, ok: false };
  return { status: 200, ok: true, json: async () => ({ title: 'Canción ' + id }) };
};

const { server, rooms, parseVideoId } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = require('http').get;
const getJson = (path, headers = {}) => new Promise((resolve, reject) => httpGet(`http://127.0.0.1:${port}${path}`, { headers }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
let port;

class Client {
  constructor(name) {
    this.name = name;
    this.id = 'client-' + name + '-' + Math.random().toString(36).slice(2);
    this.msgs = [];
    this.room = null;
    this.you = null;
  }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.msgs.push(m);
      if (m.type === 'room') { this.room = m.room; this.you = m.you; }
    });
    await new Promise((r) => this.ws.on('open', r));
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  create(opts = {}) { this.send({ type: 'create', clientId: this.id, nick: this.name, name: 'Sala test', public: true, ...opts }); }
  join(code) { this.send({ type: 'join', clientId: this.id, nick: this.name, code }); }
  last(type) { return [...this.msgs].reverse().find((m) => m.type === type); }
  errors() { return this.msgs.filter((m) => m.type === 'error').map((m) => m.code); }
  me() { return this.room.members.find((m) => m.id === this.you); }
  pidOf(nick) { return this.room.members.find((m) => m.nick === nick).id; }
}

const mkPng = (w, h, extra = 0) => { const b = Buffer.alloc(33 + extra); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log('  ✓', label); };
const eq = (a, b, label) => { assert.deepStrictEqual(a, b, label); passed++; console.log('  ✓', label); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  console.log('parseVideoId');
  eq(parseVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM'), 'dQw4w9WgXcQ', 'YT Music con playlist');
  eq(parseVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ', 'youtu.be');
  eq(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'shorts');
  eq(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'ID suelto');
  eq(parseVideoId('https://evil.com/watch?v=dQw4w9WgXcQ'), null, 'dominio ajeno rechazado');
  eq(parseVideoId('hola'), null, 'texto cualquiera rechazado');

  console.log('crear y unirse');
  const A = await new Client('Ana').open();
  A.create({ name: 'Peña <b>viernes</b>' });
  await sleep(100);
  ok(A.room && A.room.code.length === 5, 'A crea sala con código de 5 caracteres');
  eq(A.me().role, 'host', 'el creador es host');
  const code = A.room.code;

  const B = await new Client('Beto').open();
  B.join(code.toLowerCase());
  await sleep(100);
  eq(B.room.members.length, 2, 'B entra con código en minúsculas');
  eq(B.me().role, 'member', 'B es miembro común');

  const Bdup = await new Client('Ana').open();
  Bdup.join(code);
  await sleep(100);
  ok(Bdup.me().nick !== 'Ana', 'nick repetido se diferencia: ' + Bdup.me().nick);
  Bdup.send({ type: 'leave' });
  await sleep(50);

  const lost = await new Client('X').open();
  lost.join('ZZZZZ');
  await sleep(80);
  ok(lost.errors().includes('notfound'), 'código inexistente da error');

  console.log('salas públicas');
  const res = await (await fetch('http://127.0.0.1:' + port + '/api/rooms').catch(() => null))?.json?.();
  // global.fetch está mockeado, usamos http directo
  const http = require('http');
  const list = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/api/rooms`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(JSON.parse(b))); }));
  ok(list.length === 1 && list[0].code === code && list[0].listeners === 2, 'aparece en la lista pública con 2 oyentes');

  console.log('permisos de cola');
  B.send({ type: 'add', url: 'https://youtu.be/dQw4w9WgXcQ' });
  await sleep(100);
  ok(B.errors().includes('perm'), 'miembro común no puede agregar');
  B.send({ type: 'play' });
  await sleep(50);
  ok(B.errors().filter((c) => c === 'perm').length === 2, 'miembro común no puede controlar la reproducción');

  A.send({ type: 'add', url: 'https://youtu.be/dQw4w9WgXcQ' });
  await sleep(100);
  eq(A.room.current.title, 'Canción dQw4w9WgXcQ', 'la primera canción arranca sola');
  eq(A.room.playing, true, 'queda en play');
  A.send({ type: 'add', url: 'https://music.youtube.com/watch?v=aaaaaaaaaaa' });
  A.send({ type: 'add', url: 'https://music.youtube.com/watch?v=bbbbbbbbbbb' });
  await sleep(150);
  eq(B.room.queue.length, 2, 'B ve la cola con 2 canciones');

  A.send({ type: 'add', url: 'https://youtu.be/BLOCKED_001' });
  A.send({ type: 'add', url: 'https://youtu.be/MISSING_001' });
  await sleep(150);
  eq(A.errors().filter((c) => c === 'video').length, 2, 'rechaza videos con embed bloqueado y videos inexistentes');
  eq(A.room.queue.length, 2, 'la cola no cambia con los rechazados');

  console.log('sincronización');
  A.send({ type: 'pause' });
  await sleep(100);
  const posAtPause = B.room.pos;
  eq(B.room.playing, false, 'pausa llega a B');
  await sleep(300);
  A.send({ type: 'seek', pos: 90 });
  await sleep(100);
  ok(Math.abs(B.room.pos - 90) < 0.5 && B.room.playing === false, 'seek en pausa fija la posición en 90s');
  A.send({ type: 'play' });
  await sleep(600);
  A.send({ type: 'pause' });
  await sleep(100);
  ok(B.room.pos > 90.4 && B.room.pos < 91.5, 'al reanudar la posición avanza con el reloj del servidor: ' + B.room.pos.toFixed(2));

  console.log('fin de canción y votos');
  A.send({ type: 'play' });
  const curId = A.room.current.id;
  B.send({ type: 'ended', itemId: curId });
  await sleep(100);
  eq(A.room.current.id, curId, 'un solo miembro no salta la canción por su cuenta (anti-abuso)');
  await sleep(2600);
  A.send({ type: 'ended', itemId: curId });
  await sleep(100);
  eq(A.room.current.videoId, 'aaaaaaaaaaa', 'el host reporta fin y pasa a la siguiente');
  eq(A.room.queue.length, 1, 'la cola baja a 1');
  A.send({ type: 'ended', itemId: curId });
  await sleep(100);
  eq(A.room.current.videoId, 'aaaaaaaaaaa', 'reporte viejo no salta otra vez');
  await sleep(2600);
  A.send({ type: 'trackError', itemId: A.room.current.id, code: 150 });
  await sleep(100);
  eq(A.room.current.videoId, 'bbbbbbbbbbb', 'error de reproducción salta a la siguiente');
  eq(A.last('chat').msg.key, 'trackError', 'avisa en el chat');

  console.log('reacciones y chat');
  B.send({ type: 'react', emoji: '🔥' });
  B.send({ type: 'react', emoji: '🔥' });
  B.send({ type: 'react', emoji: '<script>' });
  await sleep(100);
  eq(A.last('reaction').counts, { '🔥': 2 }, 'cuenta reacciones válidas e ignora emojis inventados');
  B.send({ type: 'chat', text: '   hola    <img src=x onerror=1>  ' });
  await sleep(100);
  eq(A.last('chat').msg.text, 'hola <img src=x onerror=1>', 'chat normaliza espacios (el cliente lo muestra como texto plano)');

  console.log('historial');
  eq(A.room.history.map((h) => h.videoId), ['bbbbbbbbbbb', 'aaaaaaaaaaa', 'dQw4w9WgXcQ'], 'el historial guarda lo reproducido (más reciente primero, sin los rechazados)');
  const hDq = A.room.history.find((h) => h.videoId === 'dQw4w9WgXcQ');
  const hAa = A.room.history.find((h) => h.videoId === 'aaaaaaaaaaa');
  B.send({ type: 'playFromHistory', itemId: hDq.id });
  B.send({ type: 'queueFromHistory', itemId: hDq.id });
  await sleep(100);
  eq(B.errors().filter((c) => c === 'perm').length >= 2 && A.room.queue.length === 0, true, 'un miembro común no puede reproducir ni encolar desde el historial');
  A.send({ type: 'queueFromHistory', itemId: hDq.id });
  await sleep(100);
  eq(A.room.queue.map((q) => q.videoId), ['dQw4w9WgXcQ'], 'el host agrega a la cola desde el historial');
  A.send({ type: 'playFromHistory', itemId: hAa.id });
  await sleep(100);
  eq([A.room.current.videoId, A.room.playing, A.room.history[0].videoId], ['aaaaaaaaaaa', true, 'aaaaaaaaaaa'], 'el host reproduce ahora desde el historial y sube arriba');
  A.send({ type: 'clear' });
  await sleep(50);

  console.log('orden de la cola');
  const qv = () => A.room.queue.map((q) => q.videoId[0]);
  A.send({ type: 'add', url: 'https://youtu.be/eeeeeeeeeee' });
  A.send({ type: 'add', url: 'https://youtu.be/fffffffffff' });
  await sleep(150);
  A.send({ type: 'add', url: 'https://youtu.be/ggggggggggg', next: true });
  await sleep(150);
  eq(qv(), ['g', 'e', 'f'], '"siguiente" pone la canción primera y "al final" las deja en orden');
  A.send({ type: 'move', itemId: A.room.queue[2].id, index: 0 });
  await sleep(80);
  eq(qv(), ['f', 'g', 'e'], 'mover la última al principio');
  A.send({ type: 'move', itemId: A.room.queue[2].id, index: 1 });
  await sleep(80);
  eq(qv(), ['f', 'e', 'g'], 'mover a una posición intermedia');
  A.send({ type: 'move', itemId: A.room.queue[0].id, index: 99 });
  await sleep(80);
  eq(qv(), ['e', 'g', 'f'], 'un índice enorme la manda al final');
  A.send({ type: 'move', itemId: 'inexistente', index: 0 });
  await sleep(80);
  eq(qv(), ['e', 'g', 'f'], 'mover una canción que no existe no rompe nada');
  B.send({ type: 'move', itemId: A.room.queue[2].id, index: 0 });
  await sleep(80);
  eq([qv(), B.errors().filter((c) => c === 'perm').length >= 3], [['e', 'g', 'f'], true], 'un miembro común no puede reordenar');
  A.send({ type: 'queueFromHistory', itemId: A.room.history.find((h) => h.videoId === 'dQw4w9WgXcQ').id, next: true });
  await sleep(80);
  eq(qv()[0], 'd', 'desde el historial también se puede agregar como siguiente');
  A.send({ type: 'clear' });
  await sleep(50);

  console.log('color del chat y legibilidad');
  B.send({ type: 'setColor', color: '#ff8800' });
  await sleep(80);
  eq(A.room.members.find((m) => m.nick === 'Beto').color, '#ff8800', 'el color elegido por B lo ven todos');
  B.send({ type: 'chat', text: 'colorido' });
  await sleep(80);
  eq(A.last('chat').msg.color, '#ff8800', 'los mensajes de B llegan con su color');
  B.send({ type: 'setColor', color: 'url(javascript:alert(1))' });
  await sleep(80);
  eq(A.room.members.find((m) => m.nick === 'Beto').color, null, 'un color inválido se descarta (vuelve a automático)');
  A.send({ type: 'theme', theme: { bg: '#ffffff', panel: '#f5f5f5', text: '#eeeeee', accent: '#ff0000', accent2: '#00ff00' } });
  await sleep(80);
  ok(A.errors().includes('contrast') && A.room.theme.bg !== '#ffffff', 'el servidor rechaza texto claro sobre fondo claro (la pantalla "toda blanca")');
  A.send({ type: 'theme', theme: { bg: '#101010', panel: '#1a1a1a', text: '#222222', accent: '#ff0000', accent2: '#00ff00' } });
  await sleep(80);
  ok(A.errors().filter((c) => c === 'contrast').length === 2, 'y también texto oscuro sobre fondo oscuro');
  A.send({ type: 'theme', theme: { bg: '#f3f4f8', panel: '#ffffff', text: '#1c1f2a', accent: '#6a4cff', accent2: '#e5457a' } });
  await sleep(80);
  eq(A.room.theme.bg, '#f3f4f8', 'un tema claro bien armado sí se acepta');

  console.log('playlists (agregar varias de una)');
  B.send({ type: 'addMany', ids: ['eeeeeeeeeee'] });
  await sleep(80);
  ok(B.errors().filter((c) => c === 'perm').length >= 6, 'un miembro común no puede agregar playlists');
  A.send({ type: 'addMany', ids: ['eeeeeeeeeee', 'fffffffffff', 'BLOCKED_001', 'eeeeeeeeeee', 'corto', 42] });
  await sleep(300);
  eq(A.room.queue.map((q) => q.videoId[0]), ['e', 'f'], 'agrega en orden, sin repetidos, saltando bloqueados e IDs inválidos');
  ok(A.last('chat').msg.key === 'playlist' && A.last('chat').msg.params.total === 2 && A.last('chat').msg.params.skipped === 1, 'avisa en el chat cuántas se agregaron y cuántas no');
  A.send({ type: 'addMany', ids: ['ggggggggggg', 'hhhhhhhhhhh'], next: true });
  await sleep(300);
  eq(A.room.queue.map((q) => q.videoId[0]), ['g', 'h', 'e', 'f'], 'con "siguiente" el bloque entra primero y conserva su orden');
  A.send({ type: 'clear' });
  await sleep(50);
  A.send({ type: 'addMany', ids: ['BLOCKED_001', 'MISSING_001'] });
  await sleep(300);
  ok(A.errors().includes('video') && A.room.queue.length === 0, 'si ninguna se puede reproducir, avisa y no agrega nada');

  const getJsonA = (p) => getJson(p, { 'x-access-code': 'codigo-ana-123' });
  console.log('buscador');
  eq(await getJson('/api/config'), { search: true, needsCode: true, ownerCanToggle: false, guestsOpen: false }, 'con API key y códigos, la búsqueda está activa pero pide código');
  eq((await getJson('/api/search?q=Hola%20Mundo')).error, 'auth', 'sin código de acceso no se puede buscar');
  eq((await getJson('/api/search?q=Hola%20Mundo', { 'x-access-code': 'codigo-mal-123' })).error, 'auth', 'con código incorrecto tampoco');
  ok(apiSearchCalls === 0, 'los intentos sin código no gastan cuota de YouTube');
  eq(await getJson('/api/search-auth', { 'x-access-code': 'codigo-beto-456' }), { ok: true, label: 'beto' }, 'el código de un amigo valida y devuelve su nombre');
  eq((await getJson('/api/search-auth', { 'x-access-code': 'abc' })).ok, false, 'un código demasiado corto se ignora');
  eq((await getJson('/api/search-auth', { 'x-access-code': 'nope-nope' })).ok, false, 'código inválido en search-auth');
  const s1 = await getJsonA('/api/search?q=Hola%20Mundo');
  eq(s1.results.map((x) => x.videoId), ['sssssssss01', 'sssssssss02'], 'devuelve solo videos (descarta canales)');
  eq([s1.results[0].title, s1.results[0].channel], ['Tom & Jerry\'s "mix"', 'Canal & Co'], 'decodifica los símbolos HTML de los títulos');
  const s2 = await getJsonA('/api/search?q=%20hola%20%20MUNDO%20');
  ok(s2.cached === true && apiSearchCalls === 1, 'la misma búsqueda (otra mayúscula/espacios) sale del caché y no gasta cuota');
  await getJsonA('/api/search?q=segunda');
  await getJsonA('/api/search?q=tercera');
  eq((await getJsonA('/api/search?q=cuarta')).error, 'quota', 'al llegar al tope diario deja de llamar a YouTube (protege la cuota)');
  ok(apiSearchCalls === 3, 'solo se hicieron 3 llamadas reales a la API');
  eq((await getJsonA('/api/search?q=a')).error, 'short', 'búsquedas de 1 letra se rechazan');
  let lastErr = null;
  for (let i = 0; i < 15 && lastErr !== 'rate'; i++) lastErr = (await getJsonA('/api/search?q=spam' + i)).error;
  eq(lastErr, 'rate', 'límite de búsquedas por minuto y por IP');

  console.log('dueño (localhost)');
  process.env.LOCAL_OWNER_SEARCH = '1';
  const ownerCfg = await getJson('/api/config');
  eq([ownerCfg.search, ownerCfg.needsCode], [true, false], 'desde localhost directo no pide código');
  const ownerRes = await getJson('/api/search?q=sin%20codigo%20dueno');
  ok(ownerRes.error !== 'auth', 'el dueño busca sin código (aquí solo choca con el tope diario: ' + ownerRes.error + ')');
  eq((await getJson('/api/config', { 'x-forwarded-for': '203.0.113.9' })).needsCode, true, 'por un túnel/proxy (x-forwarded-for) sigue pidiendo código');
  eq((await getJson('/api/search?q=hola', { 'cf-connecting-ip': '203.0.113.9' })).error, 'auth', 'por el túnel de Cloudflare no se salta el código');
  eq((await getJson('/api/search?q=hola', { host: 'algo.trycloudflare.com' })).error, 'auth', 'con Host de una dirección pública tampoco');
  process.env.LOCAL_OWNER_SEARCH = '0';
  eq((await getJson('/api/config')).needsCode, true, 'LOCAL_OWNER_SEARCH=0 lo desactiva');

  console.log('abrir búsqueda a invitados');
  const postJson = (path, headers = {}) => new Promise((resolve, reject) => { const rq = require('http').request(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(JSON.parse(b))); }); rq.on('error', reject); rq.end(); });
  process.env.LOCAL_OWNER_SEARCH = '1';
  eq((await getJson('/api/config')).ownerCanToggle, true, 'el dueño ve el interruptor');
  eq((await getJson('/api/config', { 'x-forwarded-for': '203.0.113.9' })).ownerCanToggle, false, 'un invitado por el túnel no lo ve');
  eq((await postJson('/api/search-open?open=1', { 'x-forwarded-for': '203.0.113.9' })).ok, false, 'un invitado no puede abrir el buscador');
  eq((await getJson('/api/search?q=hola', { 'x-forwarded-for': '203.0.113.9' })).error, 'auth', 'sigue cerrado para invitados');
  eq((await postJson('/api/search-open?open=1')).guestsOpen, true, 'el dueño abre el buscador a invitados');
  const guestCfg = await getJson('/api/config', { 'x-forwarded-for': '203.0.113.9' });
  eq([guestCfg.search, guestCfg.needsCode], [true, false], 'los invitados ya no necesitan código');
  ok((await getJson('/api/search?q=hola', { 'x-forwarded-for': '203.0.113.9' })).error !== 'auth', 'un invitado puede buscar sin código');
  eq((await postJson('/api/search-open?open=0')).guestsOpen, false, 'el dueño lo cierra');
  eq((await getJson('/api/search?q=hola', { 'x-forwarded-for': '203.0.113.9' })).error, 'auth', 'vuelve a pedir código');
  process.env.LOCAL_OWNER_SEARCH = '0';

  console.log('roles');
  B.send({ type: 'setRole', target: B.me().id, admin: true });
  await sleep(50);
  eq(B.me().role, 'member', 'miembro no puede darse admin');
  A.send({ type: 'setRole', target: A.pidOf('Beto'), admin: true });
  await sleep(100);
  eq(B.me().role, 'admin', 'host hace admin a B');
  B.send({ type: 'add', url: 'https://youtu.be/ccccccccccc' });
  await sleep(100);
  eq(B.room.queue.length, 1, 'admin B agrega canciones');
  B.send({ type: 'kick', target: A.you });
  await sleep(50);
  ok(B.errors().includes('perm') && A.me().role === 'host', 'admin no puede expulsar al host');

  A.send({ type: 'theme', theme: { bg: '#000000', panel: '#111111', text: '#ffffff', accent: '#ff0000', accent2: '#00ff00' } });
  await sleep(80);
  eq(B.room.theme.accent, '#ff0000', 'host cambia el tema y llega a todos');
  B.send({ type: 'theme', theme: { bg: 'red', panel: '#111111', text: '#ffffff', accent: '#ff0000', accent2: '#00ff00' } });
  await sleep(80);
  ok(B.errors().includes('bad'), 'tema con colores inválidos es rechazado');
  A.send({ type: 'settings', everyoneQueue: true });
  const C = await new Client('Caro').open();
  C.join(code);
  await sleep(100);
  C.send({ type: 'add', url: 'https://youtu.be/ddddddddddd' });
  await sleep(100);
  eq(C.room.queue.length, 2, 'con "todos pueden agregar" un miembro común agrega');
  A.send({ type: 'settings', everyoneQueue: false });

  console.log('expulsión');
  A.send({ type: 'kick', target: A.pidOf('Caro') });
  await sleep(150);
  ok(C.msgs.some((m) => m.type === 'kicked'), 'C recibe aviso de expulsión');
  eq(A.room.members.length, 2, 'C sale de la lista');
  const C2 = await new Client('Caro').open();
  C2.id = C.id;
  C2.join(code);
  await sleep(100);
  ok(C2.errors().includes('banned'), 'C no puede volver a entrar');

  console.log('reconexión y traspaso de host');
  const oldRole = B.me().role;
  B.ws.terminate();
  await sleep(100);
  ok(A.room.members.find((m) => m.nick === 'Beto').online === false, 'B figura offline');
  const B2 = await new Client('Beto').open();
  B2.id = B.id;
  B2.join(code);
  await sleep(100);
  eq(B2.me().role, oldRole, 'B reconecta y conserva su rol de admin');

  A.ws.terminate();
  await sleep(700);
  eq(B2.me().role, 'host', 'si el host se va, el admin pasa a ser host');
  ok(B2.msgs.some((m) => m.type === 'chat' && m.msg.key === 'newHost'), 'se avisa en el chat');

  console.log('emotes');
  const emoteOf = (buf) => buf.toString('base64');
  const cmem = await new Client('Cami').open();
  cmem.join(code);
  await sleep(100);
  cmem.send({ type: 'addEmote', name: 'cami_ok', data: emoteOf(mkPng(32, 32)) });
  await sleep(100);
  ok(cmem.errors().includes('perm'), 'un miembro común no puede subir emotes por defecto');
  B2.send({ type: 'addEmote', name: 'Pepe_1', data: emoteOf(mkPng(32, 32)) });
  await sleep(100);
  ok(B2.room.emotes.some((e) => e.name === 'pepe_1'), 'el host sube un emote (nombre en minúsculas)');
  ok(B2.msgs.some((m) => m.type === 'chat' && m.msg.key === 'emoteAdded'), 'se avisa en el chat que se subió un emote');
  const png1 = await new Promise((resolve) => httpGet(`http://127.0.0.1:${port}/emote/${code}/pepe_1.png`, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], len: Buffer.concat(c).length })); }));
  eq([png1.status, png1.type, png1.len], [200, 'image/png', 33], 'el emote se sirve como image/png');
  const png404 = await new Promise((resolve) => httpGet(`http://127.0.0.1:${port}/emote/${code}/noexiste.png`, (r) => { r.resume(); resolve(r.statusCode); }));
  eq(png404, 404, 'un emote inexistente da 404');
  const nE = B2.errors().length;
  B2.send({ type: 'addEmote', name: 'x', data: emoteOf(mkPng(32, 32)) });
  await sleep(1400);
  B2.send({ type: 'addEmote', name: 'malo', data: Buffer.from('<svg onload=alert(1)>' + 'x'.repeat(40)).toString('base64') });
  await sleep(1400);
  B2.send({ type: 'addEmote', name: 'enorme', data: emoteOf(mkPng(2000, 2000)) });
  await sleep(1400);
  B2.send({ type: 'addEmote', name: 'pesado', data: emoteOf(mkPng(32, 32, 45000)) });
  await sleep(1400);
  await sleep(150);
  eq(B2.errors().length - nE, 4, 'rechaza nombre corto, archivo que no es PNG, dimensiones enormes y archivos pesados');
  B2.send({ type: 'settings', everyoneEmotes: true });
  await sleep(80);
  cmem.send({ type: 'addEmote', name: 'cami_ok', data: emoteOf(mkPng(16, 16)) });
  await sleep(100);
  ok(cmem.room.emotes.some((e) => e.name === 'cami_ok'), 'con la opción activada, cualquiera sube emotes');
  cmem.send({ type: 'removeEmote', name: 'pepe_1' });
  await sleep(80);
  ok(cmem.room.emotes.some((e) => e.name === 'pepe_1'), 'un miembro común no puede borrar emotes');
  B2.send({ type: 'removeEmote', name: 'pepe_1' });
  await sleep(80);
  ok(!B2.room.emotes.some((e) => e.name === 'pepe_1'), 'el host borra un emote');
  cmem.send({ type: 'leave' });
  await sleep(80);

  console.log('color de texto y reacciones con emote');
  B2.send({ type: 'setColor', tcolor: '#33ccff' });
  await sleep(100);
  eq(B2.me().tcolor, '#33ccff', 'el color del texto se guarda aparte del color del nombre');
  B2.send({ type: 'chat', text: 'hola' });
  await sleep(100);
  const cm = B2.last('chat').msg;
  ok(cm.tcolor === '#33ccff' && cm.color !== '#33ccff', 'el mensaje lleva color de nombre y de texto por separado');
  B2.send({ type: 'setColor', tcolor: 'rojo' });
  await sleep(100);
  eq(B2.me().tcolor, null, 'un color de texto inválido se descarta');
  B2.send({ type: 'addEmote', name: 'kril', data: emoteOf(mkPng(16, 16)) });
  await sleep(1500);
  B2.send({ type: 'react', emoji: ':kril:' });
  await sleep(100);
  eq(B2.last('reaction').counts[':kril:'], 1, 'se puede reaccionar con un emote de la sala');
  B2.send({ type: 'react', emoji: ':noexiste:' });
  await sleep(100);
  eq(B2.last('reaction').counts[':noexiste:'], undefined, 'un emote que no existe no cuenta como reacción');
  B2.send({ type: 'removeEmote', name: 'kril' });
  await sleep(100);
  eq(B2.room.reactions[':kril:'], undefined, 'al borrar el emote se borran también sus reacciones');

  console.log('sala vacía');
  B2.send({ type: 'leave' });
  await sleep(100);
  eq(rooms.size, 0, 'la sala se borra cuando se va el último');

  console.log(`\n${passed} comprobaciones OK`);
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ FALLÓ:', e.message);
  console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
