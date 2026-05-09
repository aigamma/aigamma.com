# scripts/build-extension-zips.ps1
#
# Builds submission-ready zip files for the AI Gamma browser extension's
# Chrome and Firefox source directories at the repo root. Replaces the
# README's prior `Compress-Archive -Path *` instruction because that
# cmdlet writes zip entries using the platform path separator (backslash
# on Windows), which Mozilla's AMO validator rejects with the error
# "Invalid file name in archive: icons\negative\icon16.png". The ZIP
# file format spec (APPNOTE.TXT, PKWARE) requires forward slashes for
# cross-platform compatibility; Chrome Web Store accepts both forms,
# AMO is strict.
#
# Approach: open the destination archive via System.IO.Compression.ZipFile,
# walk the source tree with Get-ChildItem -Recurse, and create each
# entry by hand with the entry name forced to forward-slash form via
# .Replace('\', '/'). The CompressionLevel is Optimal (matches the default
# Compress-Archive emits, so the resulting zip size is comparable).
#
# Usage from the repo root:
#   pwsh -NoProfile scripts/build-extension-zips.ps1
# To build a specific version pair other than the latest on disk:
#   pwsh -NoProfile scripts/build-extension-zips.ps1 -Version 1.1.6

[CmdletBinding()]
param(
  [string]$Version = ''
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
  $latestDir = Get-ChildItem -Path $repoRoot -Directory -Filter 'aigamma-extension-1.*' |
    Where-Object { $_.Name -notmatch 'firefox' } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $latestDir) {
    Write-Error "No aigamma-extension-1.*.* directory found in $repoRoot"
    exit 1
  }
  $Version = $latestDir.Name -replace '^aigamma-extension-', ''
}

$pairs = @(
  @{ Source = "aigamma-extension-$Version"; Zip = "aigamma-extension-$Version.zip" }
  @{ Source = "aigamma-extension-firefox-$Version"; Zip = "aigamma-extension-firefox-$Version.zip" }
)

foreach ($pair in $pairs) {
  $sourceDir = Join-Path $repoRoot $pair.Source
  $zipPath = Join-Path $repoRoot $pair.Zip

  if (-not (Test-Path $sourceDir)) {
    Write-Warning "Source directory not found: $sourceDir (skipping)"
    continue
  }

  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

  $resolvedSource = (Resolve-Path $sourceDir).Path
  $sourcePrefixLen = $resolvedSource.Length + 1

  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
  try {
    Get-ChildItem -Path $sourceDir -Recurse -File | ForEach-Object {
      $relativePath = $_.FullName.Substring($sourcePrefixLen).Replace('\', '/')
      $entry = $zip.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try {
        $fileStream = [System.IO.File]::OpenRead($_.FullName)
        try {
          $fileStream.CopyTo($entryStream)
        } finally {
          $fileStream.Dispose()
        }
      } finally {
        $entryStream.Dispose()
      }
    }
  } finally {
    $zip.Dispose()
  }

  $zipInfo = Get-Item $zipPath
  Write-Output ("{0}  {1} bytes" -f $pair.Zip, $zipInfo.Length)
}
