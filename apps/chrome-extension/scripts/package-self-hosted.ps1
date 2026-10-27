param(
	[ValidateSet("production", "staging")][string]$Profile = "production",
	[string]$NodeExecutable = "node",
	[switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (!$SkipBuild) {
	& $NodeExecutable (Join-Path $PSScriptRoot "build-self-hosted.mjs") $Profile
	if ($LASTEXITCODE -ne 0) { throw "Extension build failed" }
}
$distributionRoot = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot "dist"))
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $distributionRoot $Profile))
if ([System.IO.Path]::GetDirectoryName($packageRoot) -ne $distributionRoot) { throw "Unexpected package directory" }
$receipt = Get-Content -Raw -LiteralPath (Join-Path $packageRoot "BUILD.json") | ConvertFrom-Json
if ($receipt.profile -ne $Profile) { throw "Built package profile does not match" }
$manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "manifest.json")).Hash.ToLowerInvariant()
if ($manifestHash -ne $receipt.manifestSha256) { throw "Package manifest changed after build" }
$name = if ($Profile -eq "production") { "TAMCap-Chrome.zip" } else { "TAMCap-Chrome-Staging.zip" }
$zipPath = Join-Path $distributionRoot $name
$files = @(Get-ChildItem -LiteralPath $packageRoot -Force | ForEach-Object { $_.FullName })
Compress-Archive -LiteralPath $files -DestinationPath $zipPath -Force
[pscustomobject]@{
	profile = $Profile
	apiBaseUrl = $receipt.apiBaseUrl
	extensionId = $receipt.extensionId
	path = $zipPath
	bytes = (Get-Item -LiteralPath $zipPath).Length
	sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
} | ConvertTo-Json
