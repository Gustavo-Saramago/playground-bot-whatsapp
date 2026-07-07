$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidFile = Join-Path $projectRoot ".bot-test.pid"
$logFile = Join-Path $projectRoot "bot-runtime.log"

if (Test-Path $pidFile) {
  $existingPid = (Get-Content $pidFile -Raw).Trim()
  if ($existingPid -match "^\d+$") {
    $running = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($running) {
      Write-Output "Bot de teste ja esta ligado (PID $existingPid)."
      exit 0
    }
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

$cmd = "`$env:BOT_TEST_ONLY='true'; Set-Location -LiteralPath '$projectRoot'; node start.js *>> '$logFile'"
$proc = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-Command", $cmd -PassThru

Start-Sleep -Milliseconds 800
$running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $running) {
  Write-Output "Bot de teste nao ficou em execucao. Verifique o log para a causa: $logFile"
  if (Test-Path $logFile) {
    Write-Output "--- ultimas linhas do log ---"
    Get-Content $logFile -Tail 20
  }
  exit 1
}

Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Output "Bot de teste ligado com sucesso (PID $($proc.Id))."
Write-Output "Log: $logFile"