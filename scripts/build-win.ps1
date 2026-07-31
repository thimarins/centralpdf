$ErrorActionPreference = "Stop"

function Remove-PathWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return
  }

  for ($attempt = 1; $attempt -le 6; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $LiteralPath -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 6) {
        throw
      }
      Start-Sleep -Milliseconds 700
    }
  }
}

function Try-RemovePathWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  try {
    Remove-PathWithRetry -LiteralPath $LiteralPath
    return $true
  } catch {
    return $false
  }
}

function Stop-WorkspacePdfNextProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  $workspaceBuildRoots = @(
    (Join-Path $RepoRoot "dist-installer"),
    (Join-Path $RepoRoot "dist-installer-temp"),
    (Join-Path $RepoRoot "dist-installer-build-"),
    (Join-Path $RepoRoot "releases"),
    (Join-Path $RepoRoot "releases\latest")
  )

  Get-Process -Name "Central PDF", "PDF Next" -ErrorAction SilentlyContinue | ForEach-Object {
    $processPath = $null
    try {
      $processPath = $_.Path
    } catch {
      $processPath = $null
    }

    if (-not $processPath) {
      return
    }

    foreach ($root in $workspaceBuildRoots) {
      if ($processPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        break
      }
    }
  }
}

function Remove-FileIfExists {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  if (Test-Path -LiteralPath $LiteralPath) {
    Remove-Item -LiteralPath $LiteralPath -Force -ErrorAction SilentlyContinue
  }
}

function Copy-FileWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  for ($attempt = 1; $attempt -le 8; $attempt += 1) {
    try {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 8) {
        throw
      }
      Start-Sleep -Milliseconds 900
    }
  }
}

function Try-CopyLatestArtifact {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [Parameter(Mandatory = $true)]
    [string]$PendingDestination
  )

  try {
    Remove-FileIfExists -LiteralPath $Destination
    Copy-FileWithRetry -Source $Source -Destination $Destination
    Remove-FileIfExists -LiteralPath $PendingDestination
    return $Destination
  } catch {
    Copy-FileWithRetry -Source $Source -Destination $PendingDestination
    return $PendingDestination
  }
}

function Publish-UnpackedLatest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [Parameter(Mandatory = $true)]
    [string]$FallbackDestination
  )

  try {
    Remove-PathWithRetry -LiteralPath $Destination
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
    if (Test-Path -LiteralPath $FallbackDestination) {
      Remove-PathWithRetry -LiteralPath $FallbackDestination
    }
    return $Destination
  } catch {
    if (Test-Path -LiteralPath $FallbackDestination) {
      Remove-PathWithRetry -LiteralPath $FallbackDestination
    }
    Copy-Item -LiteralPath $Source -Destination $FallbackDestination -Recurse -Force
    return $FallbackDestination
  }
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$Arguments = @()
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Invoke-BuilderStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$Arguments = @()
  )

  & $FilePath @Arguments 2>&1 | ForEach-Object {
    $line = [string]$_
    if ($line -match "duplicate dependency references") {
      return
    }
    Write-Host $line
  }

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$currentDrive = $ExecutionContext.SessionState.Path.CurrentLocation.Drive
if ($currentDrive -and $currentDrive.Name -and $currentDrive.Name.Length -eq 1) {
  $repoRoot = $currentDrive.Name + ":\"
} else {
  $repoRoot = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
}

if (-not (Test-Path -Path (Join-Path $repoRoot "package.json"))) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
}
Set-Location -LiteralPath $repoRoot

$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$packageVersion = [string]$package.version
$releaseVersion = if ($package.releaseVersion) { [string]$package.releaseVersion } else { $packageVersion }

$installerDir = Join-Path $repoRoot "dist-installer"
$stagingDir = Join-Path $env:TEMP ("pdf-next-builder-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$releaseDir = Join-Path $repoRoot ("releases\" + $releaseVersion)
$latestDir = Join-Path $repoRoot "releases\latest"
$unpackedSourceDir = Join-Path $stagingDir "win-unpacked"
$msiSource = Join-Path $stagingDir ("Central PDF {0}.msi" -f $packageVersion)
$portableSource = Join-Path $stagingDir "Central-PDF-Portable.exe"
$msiDistTarget = Join-Path $installerDir ("Central PDF {0}.msi" -f $releaseVersion)
$portableDistTarget = Join-Path $installerDir ("Central-PDF-Portable-{0}.exe" -f $releaseVersion)
$msiTarget = Join-Path $releaseDir ("Central-PDF-{0}-win-x64.msi" -f $releaseVersion)
$portableTarget = Join-Path $releaseDir ("Central-PDF-{0}-win-x64-portable.exe" -f $releaseVersion)
$unpackedTargetDir = Join-Path $releaseDir "Central-PDF-win-x64-unpacked"
$manifestTarget = Join-Path $releaseDir "RELEASE.txt"
$latestMsiTarget = Join-Path $latestDir "Central-PDF-win-x64.msi"
$latestUnpackedTargetDir = Join-Path $latestDir "Central-PDF-win-x64-unpacked"
$latestFallbackUnpackedTargetDir = Join-Path $latestDir ("Central-PDF-win-x64-unpacked-" + $releaseVersion)
$latestManifestTarget = Join-Path $latestDir "RELEASE.txt"
$latestPendingMsiTarget = Join-Path $latestDir ("Central-PDF-{0}-win-x64.pending.msi" -f $releaseVersion)
$latestPortableTarget = Join-Path $latestDir "Central-PDF-win-x64-portable.exe"
$latestPendingPortableTarget = Join-Path $latestDir ("Central-PDF-{0}-win-x64-portable.pending.exe" -f $releaseVersion)
$releasePortableMarker = Join-Path $releaseDir "portable.txt"
$latestPortableMarker = Join-Path $latestDir "portable.txt"
$latestNoInstallGuide = Join-Path $latestDir "NO-INSTALL.txt"
$latestDataDir = Join-Path $latestDir "data"
$legacyDistUnpackedDir = Join-Path $installerDir "win-unpacked"

Stop-WorkspacePdfNextProcesses -RepoRoot $repoRoot

Remove-PathWithRetry -LiteralPath $stagingDir
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
New-Item -ItemType Directory -Path $installerDir -Force | Out-Null
Remove-FileIfExists -LiteralPath $msiDistTarget
Remove-FileIfExists -LiteralPath $portableDistTarget
[void](Try-RemovePathWithRetry -LiteralPath $legacyDistUnpackedDir)

# Vite build has UNC/network path issues on W:\ because of native realpath resolving UNC path with space.
# We build Vite in a local temporary directory C:\pdfnext-build-temp and copy it back.
Write-Host "Running local Vite build workaround..."
$tempBuild = "C:\pdfnext-build-temp"
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
if (Test-Path $tempBuild) {
  cmd /c rmdir $tempBuild\node_modules 2>$null | Out-Null
  Remove-Item -LiteralPath $tempBuild -Recurse -Force -ErrorAction SilentlyContinue | Out-Null
}
$ErrorActionPreference = $oldEAP

New-Item -ItemType Directory -Path $tempBuild -Force | Out-Null
Copy-Item -Path (Join-Path $repoRoot "package.json"), (Join-Path $repoRoot "vite.config.mjs"), (Join-Path $repoRoot "electron-builder.json") -Destination $tempBuild\
Copy-Item -Path (Join-Path $repoRoot "src") -Destination $tempBuild\src -Recurse -Force
$pdfjsSource = Join-Path $repoRoot "node_modules\pdfjs-dist"
$pdfjsTarget = Join-Path $tempBuild "node_modules\pdfjs-dist"
if (-not (Test-Path -LiteralPath $pdfjsSource)) {
  throw "Dependencia pdfjs-dist nao encontrada em $pdfjsSource"
}
New-Item -ItemType Directory -Path $pdfjsTarget -Force | Out-Null
& robocopy $pdfjsSource $pdfjsTarget /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) {
  throw "Robocopy of pdfjs-dist failed"
}

Set-Location $tempBuild
& node (Join-Path $repoRoot "node_modules/vite/bin/vite.js") build
if ($LASTEXITCODE -ne 0) {
  throw "Local Vite build workaround failed"
}

Set-Location $repoRoot
if (Test-Path (Join-Path $repoRoot "dist")) {
  Remove-PathWithRetry -LiteralPath (Join-Path $repoRoot "dist")
}
Copy-Item -Path $tempBuild\dist -Destination (Join-Path $repoRoot "dist") -Recurse -Force

$ErrorActionPreference = "SilentlyContinue"
Remove-Item -LiteralPath $tempBuild -Recurse -Force -ErrorAction SilentlyContinue | Out-Null
$ErrorActionPreference = $oldEAP

Write-Host "Local Vite build workaround completed successfully!"
$builderArgs = @(
  ("${repoRoot}\node_modules\electron-builder\cli.js"),
  "--win",
  "msi"
)
$electronDistOverride = $env:CENTRAL_PDF_ELECTRON_DIST
if ($electronDistOverride -and (Test-Path -LiteralPath $electronDistOverride)) {
  $builderArgs += "--config.electronDist=$electronDistOverride"
  Write-Host "Using Electron distribution override: $electronDistOverride"
}
$builderArgs += "--config.directories.output=$stagingDir"
Invoke-BuilderStep -FilePath "node" -Arguments $builderArgs

if (-not (Test-Path -LiteralPath $msiSource)) {
  throw "Artefato MSI nao encontrado em $msiSource"
}

if (-not (Test-Path -LiteralPath $unpackedSourceDir)) {
  throw "Artefato unpacked nao encontrado em $unpackedSourceDir"
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $latestDir -Force | Out-Null
Remove-FileIfExists -LiteralPath $latestMsiTarget
Remove-FileIfExists -LiteralPath $latestManifestTarget
Remove-PathWithRetry -LiteralPath $latestFallbackUnpackedTargetDir
Remove-PathWithRetry -LiteralPath $latestDataDir
Remove-PathWithRetry -LiteralPath $unpackedTargetDir
Copy-FileWithRetry -Source $msiSource -Destination $msiDistTarget
Copy-FileWithRetry -Source $msiSource -Destination $msiTarget
Copy-Item -LiteralPath $unpackedSourceDir -Destination $unpackedTargetDir -Recurse -Force
$latestUnpackedPublishedDir = Publish-UnpackedLatest -Source $unpackedSourceDir -Destination $latestUnpackedTargetDir -FallbackDestination $latestFallbackUnpackedTargetDir
$latestMsiFinalTarget = Try-CopyLatestArtifact -Source $msiSource -Destination $latestMsiTarget -PendingDestination $latestPendingMsiTarget

@(
  "Abra sem instalar usando:"
  "1. $(Split-Path -Leaf $latestUnpackedPublishedDir)\Central PDF.exe"
  ""
  "Observacao:"
  "O pacote portátil foi omitido para acelerar a geração do MSI."
) | Set-Content -LiteralPath $latestNoInstallGuide -Encoding UTF8

@(
  "Central PDF release $releaseVersion"
  "Package version: $packageVersion"
  "Gerado em: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  "Staging externo: $stagingDir"
  ""
  "Arquivos:"
  $msiDistTarget
  $msiTarget
  $unpackedTargetDir
) | Set-Content -LiteralPath $manifestTarget -Encoding UTF8

@(
  "Central PDF latest release"
  "Versao: $releaseVersion"
  "Package version: $packageVersion"
  "Gerado em: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  ""
  "Arquivos:"
  $latestMsiFinalTarget
  $latestUnpackedPublishedDir
  ""
  "Observacao:"
  "O pacote portátil foi omitido para acelerar a geração do MSI."
) | Set-Content -LiteralPath $latestManifestTarget -Encoding UTF8

Write-Host ""
Write-Host "Build concluido com sucesso."
Write-Host "MSI dist-installer: $msiDistTarget"
Write-Host "MSI: $msiTarget"
Write-Host "Latest MSI: $latestMsiFinalTarget"
Write-Host "Latest unpacked: $latestUnpackedTargetDir"

