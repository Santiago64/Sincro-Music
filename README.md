# 🎧 Sincro

[Español](README.md) · [English](README.en.md) · Licencia [MIT](LICENSE)

Web app **gratis, sin cuentas y sin bots** para escuchar **lo mismo, al mismo tiempo** con tus amigos (YouTube / YT Music) mientras hablan por Discord, sin compartir pantalla. Algo así como el *Jam* de Spotify, pero con YouTube.

**Cómo funciona:** no se transmite audio. El servidor guarda el *estado* de la sala (qué video, en qué segundo, play/pausa) y cada persona lo reproduce en su navegador con el reproductor oficial de YouTube. Por eso es gratis y cada uno usa su propia cuenta (con Premium logueado en el navegador, normalmente no ves anuncios). Detalle técnico en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

> **Cada grupo hospeda su propia copia** (en su PC o en un VPS). Así nadie paga un servidor central y nadie depende de nadie.

## Inicio rápido (5 minutos)

1. Instalá [Node.js](https://nodejs.org) 18 o superior.
2. Descargá este repo (botón *Code → Download ZIP*) o clonalo: `git clone https://github.com/TU_USUARIO/sincro.git`
3. En la carpeta del proyecto:
   ```bash
   npm install
   npm start
   ```
4. Abrí <http://localhost:3000>, poné un nick y creá una sala.
5. **Para que tus amigos entren** desde afuera sin abrir puertos del router, usá un túnel gratuito de Cloudflare (sin cuenta):
   ```bash
   winget install Cloudflare.cloudflared      # Windows, una sola vez
   cloudflared tunnel --url http://localhost:3000
   ```
   Te imprime una dirección `https://algo.trycloudflare.com`: esa es la que compartís (más el código de sala). Mientras tu PC y esa ventana estén abiertas, funciona. **La dirección cambia cada vez que reiniciás el túnel.**

Otras formas: [Docker](#docker), un VPS, o un túnel con dominio propio (ver [Hosting](#hosting)).

## Abrirla de nuevo cada día (resumen)

Hacen falta **dos ventanas de CMD**:

1. **Servidor** (en la carpeta del proyecto): doble clic en `iniciar.bat` (copia de `iniciar-EJEMPLO.bat` con tu clave y tus códigos). Tiene que decir "Sincro Music escuchando en http://localhost:3000".
2. **Túnel** (otra ventana, cualquier carpeta): `cloudflared tunnel --url http://localhost:3000`. Copiá la dirección `https://….trycloudflare.com` que muestra.

Después: abrí esa dirección, creá una sala y pasales a tus amigos la dirección + el código de sala. **La dirección del túnel cambia cada vez que lo reiniciás**, así que hay que pasarla de nuevo. Los códigos de búsqueda de tus amigos siguen funcionando (quedan guardados en su navegador).

Para actualizar la app: Ctrl + C en el servidor, descomprimir el zip nuevo encima de la carpeta, y volver a abrir `iniciar.bat`. Las salas y los emotes se pierden al reiniciar.

## Lo que hace

- Salas **privadas** (se entra con código o link) y **públicas** (aparecen en una lista con nombre, oyentes y canción actual).
- Sin registro: solo elegís un **nick**.
- El **host** controla todo (play, pausa, saltar, mover la barra, quitar canciones, estilo). Puede dar **admin** ⭐ a otros, que también controlan y agregan canciones. Opcional: "todos pueden agregar" (⚙️ Sala).
- El host y los admins pueden **expulsar** (el expulsado no puede volver a esa sala).
- Si el host se va, el rol pasa solo a un admin (o al que lleva más tiempo).
- **Cola compartida**: se agregan canciones pegando el link (youtube.com, youtu.be, music.youtube.com), eligiendo si van **al final** o **siguiente**. El host/admins pueden **arrastrar** las canciones para reordenarlas (⋮⋮) o mandarlas de siguiente con ⏫.
- **Playlists**: pegá el link de una playlist y se agregan todos sus videos (hasta 50 por vez) al final o como siguientes. Se leen con el propio reproductor de YouTube, sin API key ni cuota.
- **Buscador por nombre** (opcional, necesita una API key gratis, ver más abajo).
- **Subtítulos y calidad**: el botón **CC · HD** activa los controles de YouTube solo para vos (cada uno elige los suyos). Pasá el mouse sobre el video para que aparezca la barra de YouTube (CC y ⚙). Quien **controla la sala** (host/admin) tiene además el teclado de YouTube: si adelanta el video (flechas, o **Saltar adelante** de Premium con Enter), se adelanta para todos. Los retrocesos no se propagan, y a los miembros comunes la sala los vuelve a su punto.
- **Historial** de la sala: las últimas 40 canciones; el host/admins pueden reproducirlas de nuevo (▶) o mandarlas a la cola, al final o como siguiente.
- **Pantalla completa** (⛶ sobre el video) con título, reacciones y el **chat de la sala** a un costado (se puede escribir desde ahí; el ✕ del chat lo oculta y una pestaña 💬 en el borde lo vuelve a abrir).
- **Chat** (cada uno elige el color de su **nombre** y, aparte, el de su **texto** (en 🎨 Estilo, con vista previa); si un color no se lee sobre el fondo, se aclara u oscurece solo) y **reacciones** (🔥❤️😂💀👏😭🤯👎 **más los emotes de la sala**) que flotan sobre el video y se cuentan por canción.
- **Modo oscuro** con colores personalizables y presets. El host/admins eligen el estilo de la sala; cada uno puede activar "ver mi estilo personal". Hay protección de legibilidad: no se puede aplicar a la sala un texto que casi no se lee sobre el fondo, y se avisa a todos cuando el host cambia el estilo.
- **Hora** en cada mensaje del chat (en la hora de cada persona).
- **Idiomas**: español e inglés (selector arriba a la derecha; se guarda por persona y arranca según el idioma del navegador). Para sumar otro, copiá un bloque en `public/i18n.js`.
- **Emotes personalizados**: en el chat, botón 😀 → *Agregar / administrar emotes*. Subís un PNG (el navegador lo achica solo), le ponés un nombre y se usa escribiendo `:nombre:`. Por defecto suben el host y los admins; el host puede abrirlo a todos en ⚙️ Sala. Hasta 25 por sala; se borran con la sala.
- Volumen propio de cada persona.
- Si se corta internet o se refresca la página, reconecta y conserva el rol (20 s de margen).
- Las salas se borran solas cuando se va la última persona. No hay base de datos.

## Hosting

Es un servidor Node con WebSocket, así que necesita un lugar que acepte Node (no sirve GitHub Pages ni hosting estático). Opciones:

| Opción | Costo | Notas |
|---|---|---|
| **Tu PC + túnel de Cloudflare** | Gratis | Lo más simple. Funciona mientras tu PC y el túnel estén abiertos. La URL del túnel rápido cambia cada vez; con un dominio propio en Cloudflare se puede tener una URL fija. |
| **VPS barato** (cualquier proveedor) | Pago | Siempre encendido. `npm install && npm start`, con HTTPS vía Caddy/nginx o un túnel. |
| **Servicios gratis tipo Render** | Gratis | Suelen **dormir el servidor tras ~15 min sin uso** (la primera visita tarda ~1 min) y, como las salas viven en memoria, se pierden si se reinicia. Sirve para probar, no es lo ideal. Verificá las condiciones actuales del plan. |

Hace falta **HTTPS** para que los WebSockets y el reproductor funcionen bien fuera de `localhost` (el túnel de Cloudflare ya lo da).

### Docker

```bash
docker build -t sincro .
docker run -p 3000:3000 --env-file .env sincro
```

### Configuración (`.env`)

Copiá `.env.example` como `.env` y completá lo que necesites (todo es opcional). En Windows también podés usar `iniciar-EJEMPLO.bat` → `iniciar.bat`. Esos archivos **están en `.gitignore`**: tus claves nunca se suben al repo.

## Buscador por nombre (opcional)

Sin configurar nada, la web funciona pegando links. Si querés además buscar escribiendo el nombre, hace falta una **API key de YouTube Data API v3** y, para que nadie de afuera te gaste el cupo, **códigos de acceso** para vos y tus amigos (ver abajo). Es gratis (Google no cobra por usarla), pero tiene cupo: por defecto **~100 búsquedas por día para todos los usuarios de tu app juntos**.

1. Entrá a [console.cloud.google.com](https://console.cloud.google.com), creá un proyecto.
2. *APIs y servicios → Biblioteca* → buscá **YouTube Data API v3** → *Habilitar*.
3. *Credenciales → Crear credenciales → Clave de API*. Restringila a "YouTube Data API v3".
4. Arrancá el servidor con la clave (en CMD de Windows):
   ```
   set YOUTUBE_API_KEY=TU_CLAVE
   npm start
   ```
   En un hosting, se carga como variable de entorno `YOUTUBE_API_KEY`. **No la subas a GitHub ni la pegues en el código.**

### Búsqueda solo para tus amigos (códigos de acceso)

La búsqueda **solo funciona con un código de acceso**. Los armás vos (mínimo 8 caracteres, uno por amigo, con el nombre que quieras) y los cargás junto con la clave:

```
set YOUTUBE_API_KEY=TU_CLAVE
set SEARCH_ACCESS_CODES=ana:abc12345xyz,beto:mi-codigo-777,vos:otro-codigo-secreto
npm start
```

- Cada amigo toca el botón **🔑** al lado de "Agregar" (o busca algo y se lo pide) y pega **su** código. Queda guardado en su navegador.
- Para **sacarle el acceso** a alguien, sacás su código de la lista y reiniciás el servidor.
- Quien no tiene código sigue pudiendo pegar links de videos y playlists; lo único que no puede es buscar por nombre.
- Si definís `YOUTUBE_API_KEY` pero no `SEARCH_ACCESS_CODES`, la búsqueda queda **apagada** (el servidor lo avisa en consola).
- Cuando la app sea pública y quieras abrirla a todos: `set SEARCH_PUBLIC=1` (ojo: ahí el cupo gratis se acaba rápido).
- Los intentos con código incorrecto no gastan cupo de YouTube y se bloquean tras 10 fallos en 10 minutos por IP.

Cómo cuida el cupo: guarda en memoria cada búsqueda 24 h (repetirla no gasta), tiene un tope diario propio (`SEARCH_DAILY_MAX`, por defecto 90) y un máximo de 12 búsquedas por minuto por persona. Si se agota, la web avisa y se sigue pudiendo pegar links. Solo muestra videos que permiten reproducirse fuera de YouTube.

## Archivos

```
server.js            servidor: salas, permisos, sincronización, chat (solo depende de "ws")
public/index.html    pantallas
public/style.css     estilos y temas (variables CSS)
public/app.js        cliente: reproductor, cola, chat, reacciones, estilos, emotes
public/i18n.js       textos en español e inglés
test/                pruebas automáticas (npm test = protocolo, npm run test:ui = interfaz)
docs/ARQUITECTURA.md cómo funciona por dentro
.env.example         plantilla de configuración
Dockerfile           para correrlo en un contenedor
```

Sin build ni frameworks: se edita un archivo y se recarga el navegador.

## Límites y cosas a saber

- **Solo PC** (en celular el navegador pausa YouTube al bloquear la pantalla o cambiar de app).
- Algunos videos (sobre todo de sellos discográficos) bloquean la reproducción fuera de YouTube. La app los rechaza al agregarlos cuando puede detectarlo y, si no, los salta sola.
- Si alguien no tiene Premium, un anuncio lo puede desfasar unos segundos; se resincroniza solo al terminar.
- Los navegadores pueden bloquear el audio automático: si pasa, aparece un botón **"Tocá para activar el audio"**.
- Playlists: se agregan los primeros 50 videos; las privadas y los "Mix" automáticos de YouTube no se pueden leer.
- La **calidad** de video no se puede forzar desde una web (YouTube lo dejó sin efecto): se cambia con el engranaje de los controles de YouTube (botón CC · HD). Con esos controles activos, si pausás o adelantás por tu cuenta, la sala te devuelve a su punto en unos segundos.
- Protecciones básicas anti-abuso: límite de salas por IP, de mensajes por segundo, de miembros (30) y de cola (100).

## Ideas para después

Soundboard (efectos de sonido en la sala, pensado para rol), bibliotecas de packs (emotes, sonidos, fondos y fuentes cargados de una carpeta), votar para saltar canción, moderar chat (silenciar) y soporte de otras plataformas (SoundCloud primero). ¡Se aceptan ideas y PRs! Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Aviso legal y uso responsable

- Sincro **no está afiliado ni respaldado por YouTube ni Google**. Reproduce videos con el reproductor oficial incrustado (IFrame API) y la búsqueda usa la YouTube Data API con **tu propia clave**. Quien hospeda es responsable de cumplir las [condiciones de YouTube](https://www.youtube.com/t/terms) y de la API.
- No se descarga, graba ni retransmite audio: cada persona ve el video en su navegador.
- Los emotes que se suban y el contenido del chat son responsabilidad de quienes usan cada sala.
- Software provisto "tal cual", sin garantías (ver [LICENSE](LICENSE)).

## ☕ Apoyar el proyecto

Sincro es gratis y de código abierto. Si te sirve y querés invitarme un café, es **totalmente opcional**:

- [Cafecito](https://cafecito.app/firewrathness)
- [Ko-fi](https://ko-fi.com/firewrathness)

También ayuda mucho dejar una ⭐ en el repo, reportar bugs o sumar traducciones.
