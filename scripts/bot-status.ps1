$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$statusFiles = @(
  @{ Path = (Join-Path $projectRoot ".bot-test.pid"); Label = "TESTE" },
  @{ Path = (Join-Path $projectRoot ".bot.pid"); Label = "PRODUCAO" }
)

foreach ($item in $statusFiles) {
  $pidFile = $item.Path
  if (!(Test-Path $pidFile)) {
    continue
  }

  $pidValue = (Get-Content $pidFile -Raw).Trim()
  if ($pidValue -notmatch "^\d+$") {
    Write-Output "Status: DESLIGADO (PID invalido em $($item.Label))"
    exit 0
  }

  $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Output "Status: LIGADO ($($item.Label)) (PID $pidValue)"
    exit 0
  }
}

Write-Output "Status: DESLIGADO"
