$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidFile = Join-Path $projectRoot ".bot.pid"

if (!(Test-Path $pidFile)) {
  Write-Output "Bot ja esta desligado (PID file nao encontrado)."
  exit 0
}

$pidValue = (Get-Content $pidFile -Raw).Trim()
if ($pidValue -notmatch "^\d+$") {
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Output "PID invalido, arquivo removido."
  exit 0
}

$proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id ([int]$pidValue) -Force
  Write-Output "Bot desligado (PID $pidValue)."
} else {
  Write-Output "Processo nao estava em execucao (PID $pidValue)."
}

Remove-Item $pidFile -ErrorAction SilentlyContinue
