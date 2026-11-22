# Cómo funciona Sincro por dentro

Pensado para que cualquiera pueda leer el código, entenderlo y modificarlo. No hay build, ni frameworks, ni base de datos: **un servidor Node de un solo archivo** y **cuatro archivos de interfaz**.

## 1. La idea central: se sincroniza el *estado*, no el audio

Nadie transmite sonido. Cada persona abre el **reproductor oficial de YouTube** en su navegador. El servidor solo guarda esto por sala:

```js
{ current, playing, basePos, baseAt }
// current  = canción actual
// playing  = ¿está reproduciendo?
// basePos  = segundo en el que estaba la canción...
// baseAt   = ...en este instante (hora del servidor)
```

La posición "real" en cualquier momento es:

```
posición = basePos + (ahora_del_servidor - baseAt) / 1000     (si playing)
posición = basePos                                             (si está en pausa)
```

Cuando alguien con permiso toca play, pausa o la barra, el servidor actualiza `basePos/baseAt` y avisa a todos. Por eso es gratis (no hay audio que enviar), cada uno usa su propia cuenta de YouTube y con Premium no ve anuncios.

### Reloj compartido
Las computadoras tienen la hora un poco distinta. El cliente manda `ping` con su hora, el servidor responde `pong` con la suya, y el cliente calcula su **desfase** (`clock offset`). Con eso convierte "ahora del servidor" a su reloj local.

### Corrección de desvío (drift)
Cada 2 segundos el cliente compara dónde *debería* estar el video con dónde está. Si la diferencia pasa de ~1,2 s, hace `seekTo`. Hay un enfriamiento de 2,5 s entre saltos para no entrar en bucle. Si un anuncio o una conexión lenta te desfasa, te resincroniza solo.

## 2. Arquitectura

```
Navegador (public/app.js) ──WebSocket /ws──▶ server.js ──▶ rooms (Map en memoria)
        │                                        │
        └── YouTube IFrame API (audio/video)     └── /api/search → YouTube Data API v3 (opcional)
```

- **`server.js`**: servidor HTTP que entrega `public/` + servidor WebSocket (`ws`, ruta `/ws`). Todas las salas viven en un `Map` en memoria. Si se reinicia el servidor, se pierden (a propósito: simple y sin datos guardados).
- **`public/app.js`**: toda la interfaz y la lógica del cliente (sin framework). Tiene un objeto `S` con el estado y funciones que "renderizan" partes de la pantalla cuando llega un `snapshot`.
- **`public/i18n.js`**: textos en español e inglés. El servidor nunca manda frases, solo **claves** (`err.roomFull`, `sys.joined`…) y el cliente las traduce.
- **`public/index.html` / `style.css`**: pantallas y temas (variables CSS).

## 3. Protocolo WebSocket (resumen)

Todos los mensajes son JSON con un campo `type`.

**Cliente → servidor** (en `server.js`, función de manejo de mensajes, `switch (msg.type)`):

| Grupo | Mensajes |
|---|---|
| Sala | `create`, `join`, `leave`, `ping` |
| Reproducción (host/admin) | `play`, `pause`, `seek`, `next`, `ended`, `trackError` |
| Cola | `add`, `addMany`, `remove`, `clear`, `move`, `playNow`, `setTitle` |
| Historial | `playFromHistory`, `queueFromHistory` |
| Social | `chat`, `react`, `setColor` |
| Emotes | `addEmote`, `removeEmote` |
| Administración | `theme`, `settings`, `setRole`, `transferHost`, `kick` |

**Servidor → cliente**: `snapshot` (estado completo de la sala, se reenvía en cada cambio), `chat`, `history`, `pong`, `error` (con una `key` para traducir).

Los permisos se validan **siempre en el servidor** (`canControl(m)`: host o admin). El cliente solo oculta botones.

## 4. Seguridad y límites (anti-abuso)

- **Límite de mensajes** por conexión (token bucket: ráfaga 30, 6/seg; chat, reacciones y emotes cuestan más).
- **Límites por IP**: salas creadas y conexiones simultáneas. Tope de salas (300), miembros (30), cola (100).
- **Tamaño máximo** de mensaje; los textos se limpian con `cleanText`; los colores se validan con `cleanColor`.
- **Emotes**: el servidor verifica que sea un PNG real (firma + dimensiones ≤ 256 px, ≤ 40 KB), máximo 25 por sala y 48 MB en total.
- **Buscador**: la clave de YouTube vive solo en el servidor. Solo funciona con **códigos de acceso** (se guardan con hash SHA-256), con bloqueo tras 10 fallos por IP, tope diario propio y caché de 24 h.
- **Contraste**: no se puede aplicar al estilo de la sala un texto ilegible sobre su fondo.
- **Reconexión**: cada navegador tiene un `clientId`; si se corta la conexión, se conserva el rol 20 s.

## 5. Cómo probarlo

```bash
npm install
npm test          # protocolo: clientes WebSocket reales contra el servidor (97 comprobaciones)
npm run test:ui   # interfaz: simula el navegador con jsdom (136 comprobaciones)
```

## 6. Mapa del código

```
server.js
  ├─ .env opcional, LIMITS, constantes
  ├─ utilidades: cleanText, parseVideoId, cleanColor, contraste
  ├─ búsqueda: accessCodes, caché, cuota diaria, /api/search
  ├─ sala: snapshot, broadcast, startTrack/advance, roles (host/admin/member)
  ├─ emotes: parsePng, /emote/<SALA>/<nombre>.png
  └─ manejador de mensajes (switch por type)

public/app.js
  ├─ estado S, helpers de color (fitColor)
  ├─ conexión WebSocket + reloj (ping/pong)
  ├─ reproductor YouTube: initPlayer, syncPlayer (drift), controles nativos CC·HD
  ├─ cola, historial, chat (richText con :emotes:), reacciones
  └─ estilos/temas, pantalla completa con chat
```

## 7. Ideas para extender

- **Otros proveedores** (SoundCloud con su Widget API, enlaces directos a MP3): hay que abstraer el reproductor detrás de una interfaz `play/pause/seek/getPosition`. Spotify es posible pero limitado (seek en segundos enteros, canción completa solo con sesión del oyente); Apple Music exige cuenta de desarrollador paga.
- **Soundboard** y **bibliotecas de packs** (emotes, sonidos, fondos, fuentes cargados desde una carpeta del servidor).
- Persistencia opcional de salas (SQLite).
