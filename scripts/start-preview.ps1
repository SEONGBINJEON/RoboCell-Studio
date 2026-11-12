param(
    [string]$IsaacBaseUrl = 'http://100.115.197.14:8210',
    [ValidateRange(1, 65535)][int]$Port = 4178
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
    Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
}
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw 'Node.js was not found on PATH or in the existing Codex runtime. Check the installation before installing another copy.'
}
Write-Host "Node: $nodePath ($(& $nodePath --version))"
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owners = ($listener.OwningProcess | Sort-Object -Unique) -join ', '
    throw "Port $Port is already in use (PID $owners). Check http://127.0.0.1:$Port/studio.html and identify the process; this script will not stop it."
}

$previousIsaacUrl = $env:ISAAC_BASE_URL
$previousPort = $env:ROBOCELL_PREVIEW_PORT
try {
    $env:ISAAC_BASE_URL = $IsaacBaseUrl
    $env:ROBOCELL_PREVIEW_PORT = [string]$Port
    Write-Host "Studio: http://127.0.0.1:$Port/studio.html"
    Write-Host "Isaac: $IsaacBaseUrl"
    Write-Host 'Keep this terminal open. Ctrl+C stops only the local web server.'
    & $nodePath (Join-Path $PSScriptRoot 'preview.mjs')
} finally {
    $env:ISAAC_BASE_URL = $previousIsaacUrl
    $env:ROBOCELL_PREVIEW_PORT = $previousPort
}
