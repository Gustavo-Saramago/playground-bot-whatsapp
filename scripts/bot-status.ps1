$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidFile = Join-Path $projectRoot ".bot.pid"

if (!(Test-Path $pidFile)) {
  Write-Output "Status: DESLIGADO"
  exit 0
}

$pidValue = (Get-Content $pidFile -Raw).Trim()
if ($pidValue -notmatch "^\d+$") {
  Write-Output "Status: DESLIGADO (PID invalido)"
  exit 0
}

$proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
if ($proc) {
  Write-Output "Status: LIGADO (PID $pidValue)"
} else {
  Write-Output "Status: DESLIGADO (PID file obsoleto)"
}
