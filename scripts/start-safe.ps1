$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$sessionPath = Join-Path $repoRoot '.wwebjs_auth\session'

# Stop only bot-related Node/Chrome processes that can lock the WhatsApp auth session.
$targets = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -or $_.Name -eq 'chrome.exe') -and (
    $_.CommandLine -match 'playground-bot.*start\.js' -or
    $_.CommandLine -match 'npm-cli\.js.*playground-bot.*start' -or
    $_.CommandLine -match [regex]::Escape($sessionPath)
  )
}

foreach ($p in $targets) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    Write-Host "[start-safe] stopped $($p.Name):$($p.ProcessId)"
  } catch {
    Write-Host "[start-safe] skip $($p.Name):$($p.ProcessId)"
  }
}

$openAiInSession = -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)
if (-not $openAiInSession) {
  $hasKeyInLocal = $false
  if (Test-Path '.env.local') {
    $hasKeyInLocal = [bool](Select-String -Path '.env.local' -Pattern '^\s*OPENAI_API_KEY\s*=' -Quiet)
  }

  if (-not $hasKeyInLocal) {
    Write-Host '[start-safe] OPENAI_API_KEY ausente. Audio vai cair no fallback.'
    Write-Host '[start-safe] Adicione OPENAI_API_KEY=... em .env.local para fixar permanentemente.'
  }
}

npm start
