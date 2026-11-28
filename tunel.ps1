# Abre el tunel gratuito de Cloudflare, muestra la direccion para compartir
# y la copia al portapapeles. Lo llama iniciar-todo.bat.
# (Solo ASCII a proposito: Windows PowerShell 5 lee mal los acentos sin BOM.)
param([int]$Port = 3000)

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'No encuentro cloudflared. Instalalo una sola vez con:' -ForegroundColor Red
  Write-Host '    winget install Cloudflare.cloudflared'
  Write-Host 'Despues cerra esta ventana y abri iniciar-todo.bat de nuevo.'
  exit 1
}

Write-Host 'Abriendo el tunel... espera unos segundos.'
$shown = $false
& cloudflared tunnel --url "http://localhost:$Port" 2>&1 | ForEach-Object {
  $line = "$_"
  if (-not $shown -and $line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
    $shown = $true
    $url = $Matches[0]
    try { Set-Clipboard -Value $url; $copied = ' (ya copiada al portapapeles)' } catch { $copied = '' }
    # le avisa al servidor cual es la direccion publica: asi el boton Link de la sala copia esta y no "localhost"
    try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://localhost:$Port/api/public-url?url=$url" | Out-Null } catch {}
    Write-Host ''
    Write-Host '=====================================================' -ForegroundColor Green
    Write-Host '  Comparti esta direccion con tus amigos:' -ForegroundColor Green
    Write-Host "  $url" -ForegroundColor Yellow
    Write-Host "  $copied" -ForegroundColor Green
    Write-Host '  (cambia cada vez que reinicies el tunel)' -ForegroundColor Green
    Write-Host '=====================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Deja esta ventana abierta mientras escuchan. Ctrl + C para cerrar el tunel.'
  } elseif ($line -match '\bERR\b') {
    Write-Host $line -ForegroundColor Red
  }
}
