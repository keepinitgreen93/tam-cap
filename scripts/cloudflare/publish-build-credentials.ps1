#requires -Version 7.4
param(
	[Parameter(Mandatory)][string]$NodePath,
	[Parameter(Mandatory)][string]$WranglerCli,
	[ValidateRange(15, 180)][int]$ExpirationMinutes = 120
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$capRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
function Invoke-CapPrivateProcess([string]$Executable, [string[]]$Arguments, [string]$InputText = '') {
	$capStart = [Diagnostics.ProcessStartInfo]::new()
	$capStart.FileName = $Executable
	foreach ($capArgument in $Arguments) { $capStart.ArgumentList.Add($capArgument) }
	$capStart.WorkingDirectory = $capRoot
	$capStart.UseShellExecute = $false
	$capStart.CreateNoWindow = $true
	$capStart.RedirectStandardInput = $true
	$capStart.RedirectStandardOutput = $true
	$capStart.RedirectStandardError = $true
	$capProcess = [Diagnostics.Process]::Start($capStart)
	try {
		$capOutput = $capProcess.StandardOutput.ReadToEndAsync()
		$capErrors = $capProcess.StandardError.ReadToEndAsync()
		$capProcess.StandardInput.Write($InputText)
		$capProcess.StandardInput.Close()
		$capProcess.WaitForExit()
		if ($capProcess.ExitCode -ne 0) { throw "Private build credential operation failed (exit $($capProcess.ExitCode))." }
		$capErrors.GetAwaiter().GetResult() | Out-Null
		return $capOutput.GetAwaiter().GetResult()
	} finally { $capProcess.Dispose() }
}

$capRaw = Invoke-CapPrivateProcess $NodePath @($WranglerCli, 'containers', 'registries', 'credentials', '--push', '--pull', '--expiration-minutes', [string]$ExpirationMinutes, '--json', '--config', (Join-Path $capRoot 'infra/cloudflare/wrangler.runtime.jsonc'))
$capCredential = $capRaw | ConvertFrom-Json
if (-not ($capCredential.username -is [string]) -or -not $capCredential.username -or -not ($capCredential.password -is [string]) -or -not $capCredential.password) { throw 'Registry credentials were incomplete.' }
$capProtected = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($capRaw), [Text.Encoding]::UTF8.GetBytes('tam-cap-build-registry-v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes((Join-Path $capRoot '.secrets/build-registry-credentials.dpapi'), $capProtected)
$capGh = (Get-Command gh).Source
Invoke-CapPrivateProcess $capGh @('secret', 'set', 'TAM_CAP_REGISTRY_USERNAME', '--repo', 'keepinitgreen93/tam-cap') $capCredential.username | Out-Null
Invoke-CapPrivateProcess $capGh @('secret', 'set', 'TAM_CAP_REGISTRY_PASSWORD', '--repo', 'keepinitgreen93/tam-cap') $capCredential.password | Out-Null
@{ published = $true; repository = 'keepinitgreen93/tam-cap'; permissions = @('push','pull'); expiresInMinutes = $ExpirationMinutes; applicationSecretsIncluded = $false } | ConvertTo-Json
