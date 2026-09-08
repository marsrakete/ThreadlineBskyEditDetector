[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

<#
Liest die Manifest-Version der Erweiterung.
Erwartet den absoluten Pfad zu einer manifest.json.
Gibt die nicht leere Versionsnummer als Zeichenkette zurück.
#>
function Get-ExtensionVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
  )

  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestPath | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($manifest.version)) {
    throw "Die manifest.json enthält keine Version."
  }
  return [string]$manifest.version
}

<#
Führt die projektweiten Prüfungen für die Erweiterung aus.
Erwartet den absoluten Projektpfad.
Gibt keinen Wert zurück und bricht beim ersten fehlgeschlagenen Prüfschritt ab.
#>
function Invoke-ExtensionChecks {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath
  )

  $extensionPath = Join-Path $ProjectPath "bsky-edit-detector-extension\bsky-edit-detector-extension"
  $scriptPaths = @(
    (Join-Path $extensionPath "background.js"),
    (Join-Path $extensionPath "server-status.js"),
    (Join-Path $extensionPath "connection.js"),
    (Join-Path $extensionPath "content.js"),
    (Join-Path $extensionPath "permission.js")
  )
  foreach ($scriptPath in $scriptPaths) {
    & node --check $scriptPath
    if ($LASTEXITCODE -ne 0) {
      throw "Syntaxprüfung fehlgeschlagen: $scriptPath"
    }
  }
  foreach ($checkPath in @("scripts\check-server-status.cjs", "scripts\check-pds-health.cjs", "scripts\check-content-runtime.cjs")) {
    & node (Join-Path $ProjectPath $checkPath)
    if ($LASTEXITCODE -ne 0) {
      throw "Prüfung fehlgeschlagen: $checkPath"
    }
  }
}

<#
Wandelt eine Erweiterungsversion in ein vergleichbares Versionsobjekt um.
Erwartet eine Versionsnummer mit zwei bis vier Zahlen, etwa 0.5.1.
Gibt ein System.Version-Objekt zurück oder bricht bei ungültiger Eingabe ab.
#>
function ConvertTo-ArchiveVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  if ($Version -notmatch "^\d+(\.\d+){1,3}$") {
    throw "Ungültige Erweiterungsversion: $Version"
  }
  return [version]$Version
}

<#
Erstellt ein ZIP der Erweiterung im Download-Ordner.
Erwartet Quellordner, Zielordner und Versionsnummer. Nach einem erfolgreichen Build entfernt sie ältere ZIP-Versionen.
Gibt den absoluten Pfad der fertigen ZIP-Datei zurück.
#>
function New-ExtensionArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionPath,
    [Parameter(Mandatory = $true)]
    [string]$DownloadPath,
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  New-Item -ItemType Directory -Force -Path $DownloadPath | Out-Null
  $archiveVersion = ConvertTo-ArchiveVersion -Version $Version
  $archivePath = Join-Path $DownloadPath "threadline-bsky-edit-detector-v$Version.zip"
  $temporaryArchivePath = Join-Path ([System.IO.Path]::GetTempPath()) "threadline-bsky-edit-detector-$([guid]::NewGuid()).zip"

  try {
    Compress-Archive -LiteralPath $ExtensionPath -DestinationPath $temporaryArchivePath -CompressionLevel Optimal
    if (Test-Path -LiteralPath $archivePath) {
      Remove-Item -LiteralPath $archivePath -Force
    }
    Move-Item -LiteralPath $temporaryArchivePath -Destination $archivePath
  } finally {
    if (Test-Path -LiteralPath $temporaryArchivePath) {
      Remove-Item -LiteralPath $temporaryArchivePath -Force
    }
  }

  foreach ($candidate in Get-ChildItem -LiteralPath $DownloadPath -File -Filter "threadline-bsky-edit-detector-v*.zip") {
    if ($candidate.Name -notmatch "^threadline-bsky-edit-detector-v(?<version>\d+(\.\d+){1,3})\.zip$") {
      continue
    }
    $candidateVersion = ConvertTo-ArchiveVersion -Version $Matches.version
    if ($candidateVersion -lt $archiveVersion) {
      Remove-Item -LiteralPath $candidate.FullName -Force
    }
  }
  return $archivePath
}

$projectPath = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $projectPath "bsky-edit-detector-extension\bsky-edit-detector-extension"
$manifestPath = Join-Path $extensionPath "manifest.json"
$downloadPath = Join-Path $projectPath "downloads"

if (!(Test-Path -LiteralPath $manifestPath)) {
  throw "Erweiterungsmanifest nicht gefunden: $manifestPath"
}

Invoke-ExtensionChecks -ProjectPath $projectPath
$version = Get-ExtensionVersion -ManifestPath $manifestPath
$archivePath = New-ExtensionArchive -ExtensionPath $extensionPath -DownloadPath $downloadPath -Version $version
Write-Output "ZIP erstellt: $archivePath"
