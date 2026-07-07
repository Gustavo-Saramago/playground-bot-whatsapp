$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$contactsPath = Join-Path $projectRoot 'test-allowed-contacts.json'

function Normalize-Phone([string]$value) {
  return ($value -replace '\D', '').Trim()
}

if ($args.Count -eq 0) {
  $enteredPhones = Read-Host 'Digite os numeros separados por espaco ou virgula'
  if ([string]::IsNullOrWhiteSpace($enteredPhones)) {
    Write-Output 'Nenhum telefone informado.'
    exit 1
  }

  $args = @($enteredPhones -split '[,\s]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

$phones = New-Object System.Collections.Generic.List[string]
foreach ($arg in $args) {
  $normalized = Normalize-Phone $arg
  if ($normalized) {
    $phones.Add($normalized)
  }
}

if ($phones.Count -eq 0) {
  Write-Output 'Nenhum telefone valido foi informado.'
  exit 1
}

$current = @()
if (Test-Path $contactsPath) {
  try {
    $raw = Get-Content $contactsPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $parsed = $raw | ConvertFrom-Json
      if ($parsed -is [System.Collections.IEnumerable]) {
        $current = @($parsed)
      }
    }
  } catch {
    Write-Output "Falha ao ler ${contactsPath}: $($_.Exception.Message)"
    exit 1
  }
}

$set = New-Object System.Collections.Generic.HashSet[string]
foreach ($item in $current) {
  $normalized = Normalize-Phone ([string]$item)
  if ($normalized) {
    [void]$set.Add($normalized)
  }
}

foreach ($phone in $phones) {
  [void]$set.Add($phone)
}

$sorted = @($set) | Sort-Object
$sorted | ConvertTo-Json -Depth 5 | Set-Content -Path $contactsPath -Encoding UTF8

Write-Output "Numeros adicionados para teste: $($phones -join ', ')"
Write-Output "Total liberado para teste: $($sorted.Count)"
