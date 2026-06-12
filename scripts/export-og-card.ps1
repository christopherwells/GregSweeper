# Exports assets/og-card.svg to assets/og-card.png at 1200x630 via
# headless Chrome. Run from the repo root:
#   powershell -File scripts/export-og-card.ps1
$chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chrome)) {
  Write-Error "Chrome not found; install Chrome or adjust the path."
  exit 1
}
$repo = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $repo "assets\og-card.svg"
$out = Join-Path $repo "assets\og-card.png"
& $chrome --headless --disable-gpu --screenshot="$out" --window-size=1200,630 --hide-scrollbars "file:///$svg" 2>$null | Out-Null
if (Test-Path $out) {
  Write-Output "wrote og-card.png ($((Get-Item $out).Length) bytes)"
} else {
  Write-Error "export failed"
  exit 1
}
