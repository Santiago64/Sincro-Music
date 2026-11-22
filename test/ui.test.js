'use strict';
process.env.GRACE_MS = '400';
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const { server } = require('../server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error('FALLÓ: ' + l); passed++; console.log('  ✓', l); };

const resources = {
  interceptors: [
    requestInterceptor((request) => {
      if (request.url.includes('youtube.com/iframe_api')) return new Response('/* bloqueado en test */', { headers: { 'Content-Type': 'application/javascript' } });
      if (request.url.includes('i.ytimg.com')) return new Response('', { status: 204 });
    }),
  ],
};

async function openClient(base, name) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message || e) + ' ' + String((e.detail && e.detail.stack) || '').split('\n').slice(0,4).join(' ← ')));
  vc.on('error', (e) => errors.push(String(e)));
  const dom = await JSDOM.fromURL(base, { beforeParse(win) { try { win.localStorage.setItem('sincro.lang', '"' + (global.__lang || 'es') + '"'); } catch {} }, runScripts: 'dangerously', resources, pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  if (w.document.readyState !== 'complete') await new Promise((r) => w.addEventListener('load', r));
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  w.addEventListener('error', (e) => errors.push('STACK ' + String(e.error && e.error.stack).split('\n').slice(0, 4).join(' <- ')));
  w.confirm = () => true;
  w.fetch = (u, o) => fetch(new URL(u, base), o);
  const calls = [];
  w.YT = {
    PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: class {
      constructor(id, opts) {
        this.opts = opts; this.state = -1; this.t = 0; this.vol = 0; this.rate = 1;
        (w.__players = w.__players || []).push(this);
        if (opts.playerVars && opts.playerVars.list) {
          this.isList = true;
          setTimeout(() => { this.state = 5; opts.events.onStateChange && opts.events.onStateChange({ data: 5, target: this }); }, 10);
        } else {
          setTimeout(() => opts.events.onReady && opts.events.onReady(), 0);
        }
      }
      getPlaylist() { return ['pl000000001', 'pl000000002', 'pl000000003']; }
      destroy() { calls.push(['destroy', this.isList ? 'list' : 'main']); }
      getPlaybackRate() { return this.rate; }
      setPlaybackRate(r) { this.rate = r; calls.push(['rate', r]); }
      loadVideoById(o) { calls.push(['load', o.videoId]); this.state = 1; this.t = o.startSeconds || 0; }
      cueVideoById(o) { calls.push(['cue', o.videoId]); this.state = 5; }
      playVideo() { this.state = 1; calls.push(['play']); }
      pauseVideo() { this.state = 2; calls.push(['pause']); }
      stopVideo() { calls.push(['stop']); }
      seekTo(t) { this.t = t; calls.push(['seek', Math.round(t)]); }
      setVolume(v) { this.vol = v; }
      getPlayerState() { return this.state; }
      getCurrentTime() { return this.t; }
      getDuration() { return 200; }
      getVideoData() { return { title: 'Titulo real' }; }
    },
  };
  w.onYouTubeIframeAPIReady();
  w.nick = name;
  const d = w.document;
  return { w, d, calls, errors, $: (s) => d.querySelector(s), setNick() { d.querySelector('#nick').value = name; } };
}
const click = (c, sel) => c.$(sel).dispatchEvent(new c.w.MouseEvent('click', { bubbles: true }));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  console.log('lobby');
  const A = await openClient(base, 'Ana');
  ok(!A.$('#view-lobby').classList.contains('hidden'), 'el lobby se muestra');
  click(A, '#btn-create');
  ok(A.$('#toasts').textContent.includes('nick'), 'sin nick pide el nick');
  A.setNick();
  A.$('#room-name').value = 'Peña de prueba';
  A.$('#room-public').checked = true;
  click(A, '#btn-create');
  await sleep(500);
  ok(!A.$('#view-room').classList.contains('hidden'), 'Ana entra a su sala');
  const code = A.$('#room-code').textContent;
  ok(/^[A-Z2-9]{5}$/.test(code), 'se muestra el código ' + code);
  ok(A.w.location.hash === '#' + code, 'la URL queda con el código para compartir');
  ok(A.$('#room-badge').textContent.includes('pública'), 'marca sala pública');
  ok(A.$('#member-list').textContent.includes('Ana') && A.$('#member-list').textContent.includes('👑'), 'Ana figura como host 👑');
  ok(!A.$('#add-form').classList.contains('hidden'), 'host ve el formulario para agregar');
  ok(!A.$('#idle').classList.contains('hidden'), 'muestra el estado "nada sonando"');

  console.log('segundo usuario por lista pública');
  const B = await openClient(base, 'Beto');
  await B.w.refreshPublicRooms();
  await sleep(300);
  ok(B.$('#public-rooms').textContent.includes('Peña de prueba'), 'Beto ve la sala en la lista pública');
  B.setNick();
  click(B, '#public-rooms button');
  await sleep(500);
  ok(!B.$('#view-room').classList.contains('hidden'), 'Beto entra desde la lista');
  ok(B.$('#add-form').classList.contains('hidden'), 'Beto (miembro) no ve el formulario de agregar');
  ok(B.$('#btn-playpause').disabled, 'Beto no puede controlar la reproducción');
  ok(A.$('#member-list').textContent.includes('Beto'), 'Ana ve a Beto en la lista');
  ok(A.$('#member-list').querySelectorAll('button').length >= 3, 'Ana (host) ve botones de admin/host/expulsar para Beto');

  console.log('reproducción sincronizada');
  A.$('#add-url').value = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(4500); // el servidor intenta oEmbed (sin internet cae al plan B)
  ok(A.calls.some((c) => c[0] === 'load' && c[1] === 'dQw4w9WgXcQ'), 'el reproductor de Ana carga el video');
  ok(B.calls.some((c) => c[0] === 'load' && c[1] === 'dQw4w9WgXcQ'), 'el reproductor de Beto carga el mismo video');
  ok(A.$('#idle').classList.contains('hidden'), 'se oculta el cartel de "nada sonando"');
  ok(B.$('#np-title').textContent.length > 3, 'Beto ve el título: ' + B.$('#np-title').textContent);

  click(A, '#btn-playpause');
  await sleep(300);
  ok(B.$('#btn-playpause').textContent === '▶', 'la pausa de Ana llega a Beto');
  await sleep(2300);
  ok(B.calls.some((c) => c[0] === 'pause'), 'el reproductor de Beto se pausa');
  click(A, '#btn-playpause');
  await sleep(2300);
  ok(B.calls.filter((c) => c[0] === 'play').length >= 1, 'el reproductor de Beto vuelve a play');

  console.log('chat, reacciones y cola');
  B.$('#chat-input').value = 'hola <b>negrita</b>';
  B.$('#chat-form').dispatchEvent(new B.w.Event('submit', { cancelable: true }));
  await sleep(300);
  ok(A.$('#chat-log').textContent.includes('hola <b>negrita</b>'), 'el chat llega a Ana como texto plano');
  ok(A.$('#chat-log').querySelectorAll('b').length === A.$('#chat-log').querySelectorAll('.msg').length, 'el HTML del chat no se interpreta (solo el nick va en <b>)');
  click(B, '#react-bar button');
  await sleep(300);
  ok(A.$('#float-layer').children.length === 1, 'la reacción flota sobre el video de Ana');
  ok(A.$('#react-counts').textContent.includes('1'), 'se cuenta la reacción');

  A.$('#add-url').value = 'https://youtu.be/aaaaaaaaaaa';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(4500);
  ok(B.$('#queue-list').querySelectorAll('li img').length === 1, 'Beto ve la canción en la cola');

  console.log('historial, pantalla completa y link');
  ok(A.$('#history-list').textContent.includes('Todavía no'), 'el historial arranca vacío (la que suena no cuenta)');
  click(A, '#btn-next');
  await sleep(400);
  ok(A.$('#history-list').querySelectorAll('li img').length === 1, 'al pasar de canción, la anterior aparece en el historial');
  ok(B.$('#history-list').querySelectorAll('li img').length === 1, 'Beto también ve el historial');
  ok(B.$('#history-list').querySelectorAll('button').length === 0, 'Beto (miembro común) no tiene botones de reproducir/encolar');
  const plus = A.$('#history-list').querySelector('button[title="Agregar al final de la cola"]');
  ok(!!plus && !!A.$('#history-list').querySelector('button[title="Reproducir ahora"]'), 'Ana (host) ve ▶ y ＋ en cada ítem del historial');
  plus.click();
  await sleep(300);
  ok(A.$('#queue-list').querySelectorAll('li img').length === 1, 'el ＋ del historial agrega la canción a la cola');
  ok(A.$('#fs-react').querySelectorAll('button').length === 8, 'la barra de pantalla completa tiene las 8 reacciones');
  ok(A.$('#fs-title').textContent.length > 3, 'y muestra el título');
  ok(!!A.$('#btn-fs'), 'hay botón de pantalla completa');
  click(A, '#btn-link');
  ok(A.$('#toasts').textContent.includes('localhost'), 'en localhost el botón Link avisa que ese link no sirve para amigos');

  console.log('siguiente / al final y arrastrar');
  ok(!!A.$('#history-list').querySelector('button[title="Agregar como siguiente"]'), 'el historial ofrece "＋ sig." además de "＋ final"');
  A.$('#add-where').value = 'next';
  A.$('#add-url').value = 'https://youtu.be/hhhhhhhhhhh';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(4500);
  const titles = () => [...A.$('#queue-list').querySelectorAll('li .t div:first-child')].map((n) => n.textContent.slice(-3));
  ok(titles()[0] === 'hhh' && titles().length === 2, 'con "Siguiente" la canción queda primera en la cola: ' + titles().join(','));
  ok(!!A.$('#queue-list li .grip'), 'host ve el agarre ⋮⋮ para arrastrar');
  const lis = () => [...A.$('#queue-list').querySelectorAll('li')];
  ok(B.$('#queue-list li .grip') === null, 'Beto (miembro) no puede arrastrar');
  const ev = (n, t) => n.dispatchEvent(new A.w.Event(t, { bubbles: true, cancelable: true }));
  const second = lis()[1], first = lis()[0];
  ev(second, 'dragstart'); ev(first, 'dragover'); ev(first, 'drop'); ev(second, 'dragend');
  await sleep(300);
  ok(titles()[1] === 'hhh', 'arrastrar la segunda sobre la primera las intercambia: ' + titles().join(','));
  ok(B.$('#queue-list').textContent.includes('hhh') && [...B.$('#queue-list').querySelectorAll('li .t div:first-child')].map((n) => n.textContent.slice(-3))[1] === 'hhh', 'Beto ve el nuevo orden');
  A.$('#queue-list button[title="Poner de siguiente"]:last-of-type');
  [...A.$('#queue-list').querySelectorAll('button[title="Poner de siguiente"]')].pop().click();
  await sleep(300);
  ok(titles()[0] === 'hhh', 'el botón ⏫ manda una canción al primer lugar');

  console.log('color del chat y aviso de legibilidad');
  A.$('#chat-color').value = '#ff8800';
  A.$('#chat-color').dispatchEvent(new A.w.Event('change'));
  await sleep(200);
  A.$('#chat-input').value = 'mensaje naranja';
  A.$('#chat-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(300);
  const bMsgs = [...B.$('#chat-log').querySelectorAll('.msg')];
  const lastB = bMsgs[bMsgs.length - 1];
  ok(lastB.textContent.includes('mensaje naranja') && lastB.querySelector('b').style.color === 'rgb(255, 136, 0)', 'Beto ve el nombre de Ana en el color que ella eligió');
  ok(lastB.querySelector('.body').style.color === '', 'el texto del mensaje NO toma el color del nombre (son independientes)');
  A.$('#text-color').value = '#33ccff';
  A.$('#text-color').dispatchEvent(new A.w.Event('change'));
  await sleep(200);
  A.$('#chat-input').value = 'texto celeste';
  A.$('#chat-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(300);
  const lastB2 = [...B.$('#chat-log').querySelectorAll('.msg')].pop();
  ok(lastB2.querySelector('.body').style.color === 'rgb(51, 204, 255)' && lastB2.querySelector('b').style.color === 'rgb(255, 136, 0)', 'nombre naranja y texto celeste, cada uno con su color');
  A.$('#text-color-auto').dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  ok(A.w.localStorage.getItem('sincro.textColor') === 'null', 'el botón auto del texto lo vuelve al color normal');
  // un color oscuro sobre fondo oscuro se aclara en vez de ignorarse
  const fit = B.w.eval("fitColor('#1a1aff', '#181b24')");
  ok(fit && fit !== '#1a1aff' && B.w.eval(`contrast('${fit}', '#181b24')`) >= 3, 'un azul oscuro sobre fondo oscuro se aclara hasta poder leerse (no se descarta)');
  ok(B.w.eval("fitColor('#ffffff', '#181b24')") === '#ffffff', 'un color que ya se lee no se toca');
  ok([...B.$('#member-list').querySelectorAll('.n')].some((n) => n.style.color === 'rgb(255, 136, 0)'), 'y su nombre en la lista de la sala');
  click(A, '#btn-theme');
  const tin = A.$('#theme-dialog input[data-k="text"]');
  tin.value = '#181b24';
  tin.dispatchEvent(new A.w.Event('input', { bubbles: true }));
  ok(!A.$('#theme-warn').classList.contains('hidden'), 'texto igual al fondo → aparece el aviso de legibilidad');
  ok(A.$('#theme-apply-room').disabled, 'y no deja aplicarlo a la sala');
  ok(A.w.document.documentElement.style.getPropertyValue('--text') === '#ffffff', 'mientras tanto la pantalla se sigue leyendo (texto forzado a blanco)');
  click(A, '#theme-close');
  ok(A.w.document.documentElement.style.getPropertyValue('--text') !== '#ffffff', 'al cerrar sin aplicar vuelve al estilo de la sala');

  console.log('controles de YouTube (CC / calidad)');
  ok(!!A.$('#btn-yt'), 'hay botón CC · HD');
  ok(!A.$('#player-shield').classList.contains('open'), 'por defecto los controles nativos están ocultos');
  const before = A.calls.length;
  click(A, '#btn-yt');
  await sleep(2500);
  const after = A.calls.slice(before);
  ok(after.some((c) => c[0] === 'destroy' && c[1] === 'main'), 'al activarlo se vuelve a crear el reproductor');
  ok(A.$('#player-shield').classList.contains('open') && A.$('#btn-yt').classList.contains('active'), 'se destapa la barra de YouTube (CC / ⚙) y el botón queda activo');
  ok(A.w.__players.at(-1).opts.playerVars.controls === 1, 'el reproductor nuevo se crea con controls=1');
  ok(after.some((c) => c[0] === 'load' || c[0] === 'cue'), 'y retoma la canción de la sala');
  ok(!!A.$('.player-wrap #player, .player-wrap iframe'), 'queda el contenedor del reproductor en la página');
  ok(B.w.__players.at(-1).opts.playerVars.controls === 0, 'el reproductor de Beto no cambia (es una opción personal)');
  A.w.__players.at(-1).rate = 2;
  await sleep(2400);
  ok(A.w.__players.at(-1).rate === 1, 'si cambian la velocidad de YouTube, la app la vuelve a 1x para no desincronizar');
  click(A, '#btn-yt');
  await sleep(300);
  ok(!A.$('#player-shield').classList.contains('open') && A.w.__players.at(-1).opts.playerVars.controls === 0, 'al desactivarlo vuelve al modo sincronizado');

  console.log('playlists');
  const q0 = () => A.$('#queue-list').querySelectorAll('li img').length;
  const basePl = q0();
  A.$('#add-where').value = 'end';
  A.$('#add-url').value = 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(5500);
  ok(A.w.__players.some((p) => p.isList), 'lee la playlist con un reproductor oculto (sin API key)');
  ok(A.calls.some((c) => c[0] === 'destroy' && c[1] === 'list'), 'y lo elimina al terminar');
  ok(q0() === basePl + 3, "agrega los 3 videos de la playlist a la cola: " + basePl + " → " + q0());
  ok(A.$('#chat-log').textContent.includes('3 canciones de una playlist'), 'avisa en el chat');
  A.$('#add-url').value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijklmnop&index=2';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  ok(A.$('#search-results').textContent.includes('Toda la playlist') && A.$('#search-results').querySelectorAll('button').length === 3, 'un video dentro de una playlist pregunta qué agregar');
  [...A.$('#search-results').querySelectorAll('button')].find((b) => b.textContent === 'Cancelar').click();
  ok(A.$('#search-results').classList.contains('hidden'), 'Cancelar cierra la pregunta');
  A.$('#add-url').value = 'https://www.youtube.com/playlist?list=RDabcdefghijk';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  ok(A.$('#toasts').textContent.includes('Mix automáticos'), 'los Mix automáticos se rechazan con una explicación');

  console.log('buscador');
  A.$('#add-url').value = 'daft punk';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(100);
  ok(A.$('#toasts').textContent.includes('no está activada'), 'sin API key, buscar por nombre explica que hay que pegar un link');
  const realFetch = A.w.fetch;
  A.w.fetch = async (u, o) => {
    if (String(u).startsWith('/api/config')) return { json: async () => ({ search: true }) };
    if (String(u).startsWith('/api/search')) return { json: async () => ({ results: [
      { videoId: 'rs000000001', title: 'Resultado uno', channel: 'Canal A' },
      { videoId: 'rs000000002', title: 'Resultado dos', channel: 'Canal B' },
    ] }) };
    return realFetch(u, o);
  };
  await A.w.loadConfig();
  ok(A.$('#add-url').placeholder.includes('escribí para buscar'), 'con búsqueda activa, el campo invita a escribir');
  A.$('#add-url').value = 'daft punk';
  A.$('#add-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  await sleep(300);
  ok(A.$('#search-results').querySelectorAll('.item').length === 2, 'muestra los resultados con miniatura, título y canal');
  const baseS = q0();
  A.$('#search-results .item button[title="Agregar al final de la cola"]').click();
  await sleep(4500);
  ok(q0() === baseS + 1, 'el ＋ final de un resultado lo agrega a la cola');
  ok(!A.$('#search-results').classList.contains('hidden'), 'los resultados quedan abiertos para seguir agregando');
  [...A.$('#search-results').querySelectorAll('button')].find((b) => b.textContent.includes('cerrar')).click();
  ok(A.$('#search-results').classList.contains('hidden'), 'se pueden cerrar');
  A.w.fetch = realFetch;

  console.log('admin, estilo y expulsión');
  const makeAdmin = [...A.$('#member-list').querySelectorAll('button')].find((b) => b.title === 'Hacer admin');
  makeAdmin.click();
  await sleep(300);
  ok(!B.$('#add-form').classList.contains('hidden'), 'al hacerlo admin, Beto ya puede agregar');
  ok(!B.$('#btn-playpause').disabled, 'y puede controlar la reproducción');

  click(A, '#btn-theme');
  A.$('#presets button:nth-child(2)').click();
  click(A, '#theme-apply-room');
  await sleep(300);
  ok(A.w.document.documentElement.style.getPropertyValue('--accent') === '#00f0ff', 'Ana aplica el preset Neón');
  ok(B.w.document.documentElement.style.getPropertyValue('--accent') === '#00f0ff', 'Beto ve el mismo estilo de sala');
  click(B, '#btn-theme');
  B.$('#presets button:nth-child(4)').click();
  click(B, '#theme-save-mine');
  click(B, '#theme-close');
  ok(B.w.document.documentElement.style.getPropertyValue('--accent') === '#3ddc97', 'Beto activa su estilo personal solo para él');
  ok(A.w.document.documentElement.style.getPropertyValue('--accent') === '#00f0ff', 'Ana sigue viendo el de la sala');

  const kick = [...A.$('#member-list').querySelectorAll('button')].find((b) => b.title === 'Expulsar');
  kick.click();
  await sleep(500);
  ok(!B.$('#view-lobby').classList.contains('hidden'), 'Beto vuelve al lobby tras ser expulsado');
  ok(A.$('#member-list').textContent.indexOf('Beto') === -1, 'Beto desaparece de la lista de Ana');

  console.log('hora, idioma, emotes y código de acceso');
  // Ana y Beto siguen en la sala acá (Beto fue expulsado antes: lo volvemos a meter)
  const D = await openClient(base, 'Dani');
  D.setNick();
  D.$('#join-code').value = code;
  click(D, '#btn-join');
  await sleep(500);
  ok(!D.$('#view-room').classList.contains('hidden'), 'Dani entra por código');
  D.$('#chat-input').value = 'hola';
  D.$('#chat-form').dispatchEvent(new D.w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(200);
  const msgEl = [...A.$('#chat-log').querySelectorAll('.msg')].pop();
  ok(msgEl && /^\d{2}:\d{2}$/.test(msgEl.querySelector('.time').textContent), 'cada mensaje muestra la hora HH:MM');
  ok(A.$('#chat-log .sys .time'), 'los avisos del sistema también llevan hora');
  ok(A.$('#chat-log').textContent.includes('Dani entró'), 'aviso del sistema en español');

  // idioma: Dani cambia a inglés y Ana sigue en español
  const sel = D.$('#lang-room');
  sel.value = 'en';
  sel.dispatchEvent(new D.w.Event('change', { bubbles: true }));
  ok(D.$('#btn-leave').textContent === 'Leave' && D.$('#btn-theme').textContent.includes('Style'), 'al elegir English cambian los textos fijos');
  ok(D.$('#chat-input').placeholder === 'Write something…', 'y los placeholders');
  ok(D.$('#chat-log').textContent.includes('Dani joined'), 'los avisos ya escritos se re-traducen');
  ok(D.$('#room-badge').textContent.includes('public'), 'la insignia de la sala se traduce');
  ok(D.w.localStorage.getItem('sincro.lang') === '"en"', 'el idioma queda guardado');
  ok(A.$('#btn-leave').textContent === 'Salir', 'Ana sigue en español (es por persona)');

  // emotes: Ana (host) sube uno por el protocolo y se ve en el chat de todos
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  A.w.send({ type: 'addEmote', name: 'pepe', data: png });
  await sleep(250);
  ok(D.$('#emote-picker').querySelectorAll('img.emote').length === 1, 'el selector de emotes lista el nuevo emote');
  A.w.send({ type: 'chat', text: 'miren :pepe: y :noexiste:' });
  await sleep(250);
  const em = D.$('#chat-log .msg:last-child');
  ok(em.querySelectorAll('img.emote').length === 1 && em.querySelector('img.emote').getAttribute('src').includes('/emote/' + code + '/pepe.png'), ':pepe: se muestra como imagen');
  ok(em.textContent.includes(':noexiste:'), 'un :nombre: que no existe queda como texto');
  ok(D.$('#emote-admin-form').classList.contains('hidden') === false ? false : true, 'un miembro común no ve el formulario de subida');

  // código de acceso a la búsqueda
  D.w.fetch = (u, o) => {
    const url = String(u);
    const h = (o && o.headers && o.headers['X-Access-Code']) || '';
    if (url.startsWith('/api/config')) return { json: async () => ({ search: true, needsCode: true }) };
    if (url.startsWith('/api/search-auth')) return { json: async () => (h === 'codigo-bueno-1' ? { ok: true, label: 'dani' } : { ok: false }) };
    if (url.startsWith('/api/search')) return { json: async () => (h === 'codigo-bueno-1' ? { results: [{ videoId: 'xxxxxxxxxxx', title: 'Algo', channel: 'Canal' }] } : { error: 'auth' }) };
    return fetch(new URL(u, base), o);
  };
  await D.w.loadConfig();
  ok(!D.$('#btn-key').classList.contains('hidden'), 'si el servidor pide código, aparece el botón 🔑');
  D.w.eval('S.room.settings.everyoneQueue = true; renderRoom();');
  D.$('#add-url').value = 'una cancion';
  D.$('#add-form').dispatchEvent(new D.w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(150);
  ok(D.$('#code-dialog').hasAttribute('open'), 'buscar sin código abre el diálogo de código');
  D.$('#access-code').value = 'codigo-malo-xx';
  click(D, '#access-ok');
  await sleep(100);
  ok(!D.$('#access-msg').classList.contains('hidden') && D.$('#access-msg').textContent.includes('not valid'), 'código incorrecto: mensaje en inglés');
  D.$('#access-code').value = 'codigo-bueno-1';
  click(D, '#access-ok');
  await sleep(300);
  ok(!D.$('#code-dialog').hasAttribute('open') && D.w.localStorage.getItem('sincro.searchCode') === '"codigo-bueno-1"', 'código correcto: se guarda y cierra');
  ok(D.$('#search-results .item'), 'y la búsqueda pendiente se ejecuta sola');

  console.log('emotes como reacciones');
  const png2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  // Ana es host en su sala: sube un emote y lo usa como reacción
  A.w.send({ type: 'addEmote', name: 'kril', data: png2 });
  await sleep(300);
  const reactBtns = [...A.$('#react-bar').querySelectorAll('button')];
  ok(reactBtns.length === 10 && reactBtns.at(-1).querySelector('img.emote'), 'la barra de reacciones suma los emotes de la sala (8 emojis + 2 emotes)');
  ok(A.$('#fs-react').querySelectorAll('button').length === 10, 'y también la barra de pantalla completa');
  reactBtns.at(-1).dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok(A.$('#react-counts').querySelector('img.emote') && A.$('#react-counts').textContent.includes('1'), 'el contador muestra la imagen del emote con su cantidad');
  ok(A.$('#float-layer').querySelector('img.emote'), 'el emote flota sobre el video como los emojis');

  console.log('colores en estilo y chat en pantalla completa');
  ok(!A.$('.chat #chat-color') && !A.$('.chat #text-color'), 'los colores de nombre y texto ya no están sobre el chat');
  ok(A.$('#theme-dialog #chat-color') && A.$('#theme-dialog #text-color') && A.$('#theme-dialog #cp-nick'), 'están dentro de Estilo, con vista previa');
  A.$('#text-color').value = '#ff00aa';
  A.$('#text-color').dispatchEvent(new A.w.Event('input', { bubbles: true }));
  ok(A.$('#cp-text').style.color !== '', 'la vista previa cambia al mover el color');
  click(A, '#btn-yt');
  await sleep(300);
  ok(A.w.eval("document.querySelector('.player-wrap').classList.contains('native')") && A.$('#player-shield').classList.contains('open'), 'con los controles de YouTube activos el reproductor lo marca (la barra nuestra sube para no tapar la de YouTube)');
  click(A, '#btn-yt');
  await sleep(300);
  ok(!A.w.eval("document.querySelector('.player-wrap').classList.contains('native')"), 'y al desactivarlos vuelve a la normalidad');
  let fsCalled = 0;
  A.$('#fs-root').requestFullscreen = () => { fsCalled++; return Promise.resolve(); };
  click(A, '#btn-fs');
  ok(fsCalled === 1, 'pantalla completa se pide sobre el contenedor que incluye el chat');
  ok(!!A.$('#fs-root #fs-chat') && !!A.$('#fs-root .player-wrap'), 'el chat va dentro del mismo contenedor que el video');
  D.$('#chat-input').value = 'mensaje para el chat grande';
  D.$('#chat-form').dispatchEvent(new D.w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
  ok(A.$('#fs-chat-log').textContent.includes('mensaje para el chat grande'), 'los mensajes también aparecen en el chat de pantalla completa');
  ok(A.$('#fs-chat-log .time'), 'con su hora');
  A.$('#fs-chat-input').value = 'respondo desde pantalla completa';
  A.$('#fs-chat-form').dispatchEvent(new A.w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
  ok(D.$('#chat-log').textContent.includes('respondo desde pantalla completa'), 'se puede escribir desde el chat de pantalla completa y llega a todos');
  ok(!A.$('#fs-root').classList.contains('nochat'), 'el chat grande viene activado por defecto');
  click(A, '#btn-fs-chat');
  ok(A.$('#fs-root').classList.contains('nochat') && A.w.localStorage.getItem('sincro.fsChat') === 'false', '💬 lo oculta y lo recuerda');
  click(A, '#btn-fs-chat');
  ok(!A.$('#fs-root').classList.contains('nochat'), 'y lo vuelve a mostrar');

  console.log('chat de pantalla completa: acceso siempre a mano');
  click(A, '#btn-fs-chat');
  ok(A.$('#fs-root').classList.contains('nochat'), 'el botón ✕ está dentro del propio chat (no depende de pasar el mouse)');
  click(A, '#fs-chat-tab');
  ok(!A.$('#fs-root').classList.contains('nochat'), 'y con el chat oculto queda una pestaña 💬 siempre visible para volver a abrirlo');

  console.log('teclado de YouTube y saltar adelante (solo quien controla)');
  click(A, '#btn-yt');
  await sleep(2500);
  const pA = A.w.__players.at(-1);
  ok(pA.opts.playerVars.controls === 1 && pA.opts.playerVars.disablekb === 0, 'el host con controles de YouTube activos tiene también el teclado de YouTube');
  click(D, '#btn-yt');
  await sleep(2500);
  const pD = D.w.__players.at(-1);
  ok(pD.opts.playerVars.controls === 1 && pD.opts.playerVars.disablekb === 1, 'un miembro común tiene los controles pero NO el teclado (no puede adelantar a la sala)');
  const room0 = A.w.eval('S.room.current && S.room.playing');
  ok(!!room0, 'hay una canción sonando para probar el salto');
  A.w.eval('S.syncOkAt = 0; S.lastJumpAt = 0;');
  const tgt = A.w.eval('targetPos()');
  pA.state = 1; pA.t = tgt + 12; // el host salta 12 s con "Saltar adelante"
  A.w.eval('checkJump()');
  await sleep(400);
  const dPos = D.w.eval('targetPos()');
  ok(dPos > tgt + 9, 'el salto del host se propaga: Dani también queda ~12 s más adelante (' + Math.round(dPos - tgt) + ' s)');
  A.w.eval('S.syncOkAt = 0; S.lastJumpAt = 0;');
  const jumpBefore = A.w.eval('S.lastJumpAt');
  pA.t = A.w.eval('targetPos()') - 12;
  A.w.eval('checkJump()');
  ok(A.w.eval('S.lastJumpAt') === jumpBefore, 'un retroceso NO se propaga (se confundiría con un corte de buffering)');
  pA.t = A.w.eval('targetPos()') + 12;
  pA.state = 3; // buffering
  A.w.eval('checkJump()');
  ok(A.w.eval('S.lastJumpAt') === jumpBefore, 'ni mientras está cargando');
  D.w.eval('S.syncOkAt = 0; S.lastJumpAt = 0;');
  pD.state = 1; pD.t = D.w.eval('targetPos()') + 12;
  D.w.eval('checkJump()');
  ok(D.w.eval('S.lastJumpAt') === 0, 'un miembro común no puede adelantar a la sala aunque salte');
  pA.state = 1;
  A.w.eval('S.kbOn = false;'); // simula un cambio de rol
  A.w.eval('renderRoom()');
  await sleep(300);
  ok(A.w.__players.at(-1).opts.playerVars.disablekb === 0 && A.w.__players.at(-1) !== pA, 'si cambia el rol, el reproductor se recrea con el teclado que corresponde');
  click(A, '#btn-yt');
  click(D, '#btn-yt');
  await sleep(2500);

  // regresión: los selectores de color del chat no deben contarse como colores del tema
  click(A, '#btn-theme');
  A.$('#chat-color').value = '#00ff88';
  A.$('#chat-color').dispatchEvent(new A.w.Event('input', { bubbles: true }));
  ok(!('undefined' in A.w.eval('S.themeDraft')), 'mover el color del nombre no ensucia el borrador del tema');
  ok(A.$('#chat-color').value === '#00ff88', 'y el selector conserva su valor al refrescar el diálogo');
  click(A, '#theme-close');

  console.log('salir');
  click(A, '#btn-leave');
  await sleep(300);
  ok(!A.$('#view-lobby').classList.contains('hidden'), 'Ana vuelve al lobby al salir');

  const errs = [...A.errors, ...B.errors].filter((e) => !/Could not load|Not implemented|navigation/i.test(e));
  ok(errs.length === 0, 'sin errores de JavaScript en consola' + (errs.length ? ': ' + errs.join(' | ') : ''));

  console.log(`\n${passed} comprobaciones de interfaz OK`);
  process.exit(0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
