$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$targets = @(
  (Join-Path $repoRoot "dist-installer\win-unpacked"),
  (Join-Path $repoRoot "dist-installer-temp")
)

# Any leftover timestamped staging folder from a previous build run
$targets += Get-ChildItem -LiteralPath $repoRoot -Directory -Filter "dist-installer-build-*" -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "SKIP: $target"
    continue
  }

  try {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    Write-Host "REMOVED: $target"
  } catch {
    Write-Host "FAILED: $target"
    Write-Host $_.Exception.Message
  }
}
