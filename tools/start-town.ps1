# Serve the built town for the phone.
#
# `npm run build:town` writes dist/ with base /town/; this serves it plus the API on 5275,
# loopback only, answering to the routerbox.xyz host the reverse proxy carries. Caddy (in the
# decklights2 Caddyfile) mounts it at https://routerbox.xyz/town/ behind basic auth. Nothing
# here faces the network on its own.
#
# Run it after a reboot, or after `npm run build:town`. Idempotent: an instance already on
# 5275 is left alone.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$busy = Get-NetTCPConnection -LocalPort 5275 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "town already serving on 5275 (pid $($busy.OwningProcess))"
    exit 0
}
if (-not (Test-Path (Join-Path $root 'dist\index.html'))) {
    Write-Host 'no dist/ yet - run: npm run build:town'
    exit 1
}
$env:PORT = '5275'
$env:BOT_CROSSING_HOSTS = 'routerbox.xyz'
Start-Process -FilePath 'node' -ArgumentList 'server/serve.mjs' -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 2
$now = Get-NetTCPConnection -LocalPort 5275 -State Listen -ErrorAction SilentlyContinue
if ($now) { Write-Host "town serving on 5275 (pid $($now.OwningProcess))" } else { Write-Host 'town did not start - check node server/serve.mjs by hand'; exit 1 }
