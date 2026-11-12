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

# Fallback: usa il Node incorporato in VS Code (Electron) tramite
# ELECTRON_RUN_AS_NODE. Code.exe e' un'app GUI: stdout NON viene collegato
# al terminale, quindi l'esito del test e' determinato solo dall'exit code.
function Resolve-VsCodeNodePath {
    $candidates = @(
        'C:\Program Files\Microsoft VS Code\Code.exe',
        'C:\Program Files (x86)\Microsoft VS Code\Code.exe',
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
    )

    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }

    return $null
}

$nodeExe = Resolve-NodePath
if ($nodeExe) {
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
    exit 0
}

# Nessun Node standalone: usa il Node incorporato in VS Code.
$vscodeExe = Resolve-VsCodeNodePath
if (-not $vscodeExe) {
    Write-Error 'Node.js non trovato e VS Code non trovato. Installare Node.js o VS Code.'
    exit 1
}

Write-Host "Node non trovato: uso il Node incorporato in VS Code: $vscodeExe"
Write-Host 'NOTA: Code.exe e una app GUI, stdout non viene mostrato. Lesito e dato dallexit code.'
Write-Host "Repo: $repoRoot"

Push-Location $repoRoot
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    # Code.exe e' una app GUI: PowerShell non attende con l'operatore '&' e
    # $LASTEXITCODE resta vuoto. Start-Process -Wait -PassThru attende la fine
    # del processo e restituisce l'ExitCode reale.
    $proc = Start-Process -FilePath $vscodeExe -ArgumentList $jsTest -Wait -PassThru -NoNewWindow
    $code = $proc.ExitCode
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    if ($code -eq 0) {
        Write-Host 'OK - test regressione linter superati (exit code 0)'
    } else {
        Write-Error "KO - test regressione linter falliti (exit code $code)"
    }
    exit $code
}
finally {
    Pop-Location
}
