# Serve A2A Proving Ground on http://localhost:PORT and open it in your browser.
#
#   .\serve.ps1              # port 8765
#   .\serve.ps1 -Port 9000   # another port
#   .\serve.ps1 -NoOpen      # don't open a browser
#
# If PowerShell refuses to run local scripts:
#   powershell -ExecutionPolicy Bypass -File .\serve.ps1
#
# Needs Python 3 (the "py" launcher from python.org, or "python"). Stop with Ctrl+C.
param(
  [int]$Port = 8765,
  [switch]$NoOpen
)

Set-Location -Path $PSScriptRoot

$py = Get-Command py -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Host "Python 3 not found. Alternatives from this folder:" -ForegroundColor Yellow
  Write-Host "  npx --yes serve -l $Port ."
  Write-Host "  docker run --rm -p ${Port}:80 -v ${PWD}:/usr/share/nginx/html:ro nginx:alpine"
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host "A2A Proving Ground  ->  $url"
Write-Host "Serving $PSScriptRoot on 127.0.0.1:$Port. Press Ctrl+C to stop."

if (-not $NoOpen) {
  # Open the browser a moment after the server starts.
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 1; Start-Process '$url'" | Out-Null
}

& $py.Source -m http.server $Port --bind 127.0.0.1
