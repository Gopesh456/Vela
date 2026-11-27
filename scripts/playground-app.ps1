# Opens the playground's multi-chart page as a desktop app: a Chrome app window (Edge's when
# Chrome isn't installed). Starts the playground server first when it isn't running; the server
# then stays up in the background until you sign out. The "Vela" Start menu shortcut runs this
# without a window: conhost.exe --headless powershell.exe -File scripts\playground-app.ps1
$root = Split-Path $PSScriptRoot -Parent
$base = 'http://localhost:5190'

function Test-Server {
    try { (Invoke-WebRequest "$base/__state" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

if (-not (Test-Server)) {
    # -NoNewWindow: the server shares this script's windowless console instead of opening its own.
    Start-Process npm.cmd -ArgumentList 'run', 'playground' -WorkingDirectory $root -NoNewWindow
    for ($i = 0; $i -lt 120 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
}

$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
# A fixed profile keeps the window's taskbar identity stable, so it groups with the pinned shortcut.
Start-Process $browser -ArgumentList "--app=$base/workspace.html", '--profile-directory=Default'
