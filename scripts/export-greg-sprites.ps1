# Exports the chosen Greg direction's SVG masters to the three PNG
# sprite slots (assets/sprites/idle.png, win.png, loss.png) at 512x512
# with a transparent background, via headless Chrome.
#
# Usage (from the repo root):
#   powershell -File scripts/export-greg-sprites.ps1 -Direction c
#
# The direction letter matches the candidate files in
# assets/sprites/greg/ (a-idle.svg, b-idle.svg, c-idle.svg, ...).
param(
  [Parameter(Mandatory = $true)][ValidateSet('a', 'b', 'c')]
  [string]$Direction
)

$chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chrome)) {
  Write-Error "Chrome not found; install Chrome or adjust the path."
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
$poses = @{ idle = 'idle.png'; win = 'win.png'; loss = 'loss.png' }

foreach ($pose in $poses.Keys) {
  $svg = Join-Path $repo "assets\sprites\greg\$Direction-$pose.svg"
  $out = Join-Path $repo "assets\sprites\$($poses[$pose])"
  if (-not (Test-Path $svg)) {
    Write-Error "Missing $svg"
    exit 1
  }
  & $chrome --headless --disable-gpu --screenshot="$out" --window-size=512,512 --default-background-color=00000000 "file:///$svg" 2>$null | Out-Null
  if (-not (Test-Path $out)) {
    Write-Error "Export failed for $pose"
    exit 1
  }
  $size = (Get-Item $out).Length
  Write-Output "wrote $($poses[$pose]) from $Direction-$pose.svg ($size bytes)"
}
Write-Output "Done. Bump CACHE_NAME on deploy so the new bytes ship."
