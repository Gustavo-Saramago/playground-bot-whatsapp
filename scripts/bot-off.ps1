$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidFiles = @(
  Join-Path $projectRoot ".bot.pid",
  Join-Path $projectRoot ".bot-test.pid"
)

$stoppedAny = $false
foreach ($pidFile in $pidFiles) {
  if (!(Test-Path $pidFile)) {
    continue
  }

  $pidValue = (Get-Content $pidFile -Raw).Trim()
  if ($pidValue -notmatch "^\d+$") {
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Output "PID invalido em $pidFile, arquivo removido."
    continue
  }

  $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id ([int]$pidValue) -Force
    Write-Output "Bot desligado (PID $pidValue)."
    $stoppedAny = $true
  } else {
    Write-Output "Processo nao estava em execucao (PID $pidValue)."
  }

  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

if (-not $stoppedAny) {
  Write-Output "Bot ja esta desligado (PID file nao encontrado)."
}
