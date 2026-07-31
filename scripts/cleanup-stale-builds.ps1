$ErrorActionPreference = "Stop"

$targets = @(
  "C:\Projetos\Central PDF\dist-installer\win-unpacked",
  "C:\Projetos\Central PDF\dist-installer-build-20260519-201159",
  "C:\Projetos\Central PDF\dist-installer-temp"
)

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
