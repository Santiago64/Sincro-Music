@echo off
REM 1) Copiá este archivo como "iniciar.bat" (en esta misma carpeta).
REM 2) Cambiá TU_CLAVE y los códigos. Cada código: mínimo 8 caracteres, sin espacios ni & | < > ^ %
REM 3) "iniciar.bat" está en .gitignore: no se sube a GitHub. Igual, no lo compartas: tiene tu clave.
REM    (Alternativa: usá un archivo ".env", ver .env.example)
set YOUTUBE_API_KEY=TU_CLAVE
set SEARCH_ACCESS_CODES=vos:codigo-largo-uno,amigo1:codigo-largo-dos,amigo2:codigo-largo-tres
npm start
