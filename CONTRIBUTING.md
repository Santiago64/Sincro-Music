# Contribuir / Contributing

¡Gracias por querer ayudar! / Thanks for helping!

1. Hacé un fork y creá una rama.
2. `npm install`, y antes de enviar el cambio: `npm test` y `npm run test:ui` tienen que pasar.
3. Si agregás un texto en pantalla, ponelo en **español e inglés** en `public/i18n.js` (el servidor solo manda claves).
4. Los permisos se validan en el servidor, nunca solo en el cliente.
5. Mantené el proyecto simple: sin build, sin frameworks, una sola dependencia de ejecución (`ws`).
6. Leé `docs/ARQUITECTURA.md` para ubicarte en el código.

No subas claves, códigos de acceso ni archivos `.env`.
