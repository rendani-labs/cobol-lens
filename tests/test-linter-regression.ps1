$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$jsTest = Join-Path $scriptDir 'test-linter-regression.js'

function Resolve-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe',
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )

    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }

    return $null
}

$nodeExe = Resolve-NodePath
if (-not $nodeExe) {
    Write-Error 'Node.js non trovato. Installare Node.js o aggiungerlo al PATH.'
    exit 1
}

Write-Host "Uso Node: $nodeExe"
Write-Host "Repo: $repoRoot"

Push-Location $repoRoot
try {
    & $nodeExe $jsTest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
