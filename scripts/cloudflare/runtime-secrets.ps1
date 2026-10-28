#requires -Version 7.4
param(
	[ValidateSet('Initialize', 'Verify', 'Publish')]
	[string]$Operation = 'Verify',
	[string]$Origin,
	[switch]$RotateAuthSecret,
	[ValidatePattern('^[a-p]{32}$')]
	[string]$ChromeExtensionId
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$capRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$capDirectory = Join-Path $capRoot '.secrets'
$capKeyPath = Join-Path $capDirectory 'runtime-key.dpapi'
$capSealedPath = Join-Path $capDirectory 'runtime.json'
$capEntropy = [Text.Encoding]::UTF8.GetBytes('tam-cap-runtime-key-v1')
$capAad = [Text.Encoding]::UTF8.GetBytes('TAM Cap runtime backup v1')
[IO.Directory]::CreateDirectory($capDirectory) | Out-Null
$capRsa = [Security.Cryptography.RSA]::Create(3072)
try {
	if (-not (Test-Path -LiteralPath $capKeyPath)) {
		if ($Operation -ne 'Initialize') { throw 'Initialize the protected runtime backup key first.' }
		if (Test-Path -LiteralPath $capSealedPath) { throw 'A sealed backup already exists. Restore its protected key instead of generating a new one.' }
		$capPrivate = [Text.Encoding]::UTF8.GetBytes($capRsa.ToXmlString($true))
		$capProtected = [Security.Cryptography.ProtectedData]::Protect($capPrivate, $capEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
		[IO.File]::WriteAllBytes($capKeyPath, $capProtected)
	} else {
		$capPrivate = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($capKeyPath), $capEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
		$capRsa.FromXmlString([Text.Encoding]::UTF8.GetString($capPrivate))
	}
	if ($Operation -eq 'Initialize') {
		$capPublic = [Convert]::ToBase64String($capRsa.ExportSubjectPublicKeyInfo(), [Base64FormattingOptions]::InsertLineBreaks)
		@{ publicKey = "-----BEGIN PUBLIC KEY-----`n$capPublic`n-----END PUBLIC KEY-----"; protectedKey = $capKeyPath } | ConvertTo-Json
		return
	}
	$capEnvelope = Get-Content -LiteralPath $capSealedPath -Raw | ConvertFrom-Json
	if ($capEnvelope.version -ne 1) { throw 'Unsupported protected backup format.' }
	$capAesKey = $capRsa.Decrypt([Convert]::FromBase64String($capEnvelope.wrappedKey), [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
	$capCiphertext = [Convert]::FromBase64String($capEnvelope.ciphertext)
	$capPlaintext = [byte[]]::new($capCiphertext.Length)
	$capAes = [Security.Cryptography.AesGcm]::new($capAesKey, 16)
	try {
		$capAes.Decrypt([Convert]::FromBase64String($capEnvelope.nonce), $capCiphertext, [Convert]::FromBase64String($capEnvelope.tag), $capPlaintext, $capAad)
	} finally { $capAes.Dispose() }
	$capPayload = [Text.Encoding]::UTF8.GetString($capPlaintext) | ConvertFrom-Json -AsHashtable
	if ($capPayload.web.CLOUDFLARE_ACCOUNT_ID -ne 'c1e96a4b36c73f3cf4ddf50a90082d94' -or $capPayload.web.CAP_OWNER_EMAIL -ne 'hello@trulyauthenticmarketing.com') { throw 'Protected backup belongs to another deployment.' }
	foreach ($capRequired in @('NEXTAUTH_SECRET', 'DATABASE_ENCRYPTION_KEY', 'RESEND_API_KEY', 'CAP_AWS_SECRET_KEY', 'CLOUDFLARE_AI_API_TOKEN')) {
		if (-not $capPayload.web[$capRequired]) { throw "Missing protected field: $capRequired" }
	}
	if (-not $capPayload.media) { throw 'Missing protected media credential.' }
	if ($Operation -eq 'Verify') {
		@{ verified = $true; owner = $capPayload.web.CAP_OWNER_EMAIL; origin = $capPayload.web.WEB_URL; maintenanceConfigured = [bool]$capPayload.web.CRON_SECRET } | ConvertTo-Json
		return
	}
	if (-not $capPayload.web.CRON_SECRET) {
		$capPayload.web.CRON_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
	}
	if ($RotateAuthSecret) {
		$capPayload.web.NEXTAUTH_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
	}
	if ($ChromeExtensionId) {
		$capPayload.web.CAP_CHROME_EXTENSION_ID = $ChromeExtensionId
	}
	if ($Origin) {
		if ($Origin -notin @('https://videos.trulyauthenticmarketing.com', 'https://tam-cap-app.ciglesia.workers.dev')) { throw 'Origin must be the configured staging or production origin.' }
		$capPayload.web.WEB_URL = $Origin
		$capPayload.web.NEXTAUTH_URL = $Origin
	}
	$capWranglerCli = Join-Path $env:APPDATA 'npm/node_modules/wrangler/bin/wrangler.js'
	if (-not (Test-Path -LiteralPath $capWranglerCli)) { throw 'Install and authenticate Wrangler before publishing.' }
	$capSecretValues = @{ CAP_WEB_ENV = ($capPayload.web | ConvertTo-Json -Compress -Depth 10); MEDIA_SERVER_WEBHOOK_SECRET = $capPayload.media }
	foreach ($capName in $capSecretValues.Keys) {
		$capStart = [Diagnostics.ProcessStartInfo]::new()
		$capStart.FileName = (Get-Command node).Source
		foreach ($capArgument in @($capWranglerCli, 'secret', 'put', $capName, '--name', 'tam-cap-app', '--config', (Join-Path $capRoot 'infra/cloudflare/wrangler.jsonc'))) { $capStart.ArgumentList.Add($capArgument) }
		$capStart.UseShellExecute = $false
		$capStart.CreateNoWindow = $true
		$capStart.RedirectStandardInput = $true
		$capStart.RedirectStandardOutput = $true
		$capStart.RedirectStandardError = $true
		$capProcess = [Diagnostics.Process]::Start($capStart)
		$capOutput = $capProcess.StandardOutput.ReadToEndAsync()
		$capErrors = $capProcess.StandardError.ReadToEndAsync()
		$capProcess.StandardInput.Write($capSecretValues[$capName])
		$capProcess.StandardInput.Close()
		$capProcess.WaitForExit()
		if ($capProcess.ExitCode -ne 0) { throw 'Cloudflare secret update failed. Check wrangler whoami.' }
		$capOutput.GetAwaiter().GetResult() | Out-Null
		$capErrors.GetAwaiter().GetResult() | Out-Null
		$capProcess.Dispose()
	}
	$capAesKey = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
	$capNonce = [Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
	$capPlaintext = [Text.Encoding]::UTF8.GetBytes(($capPayload | ConvertTo-Json -Compress -Depth 10))
	$capCiphertext = [byte[]]::new($capPlaintext.Length)
	$capTag = [byte[]]::new(16)
	$capAes = [Security.Cryptography.AesGcm]::new($capAesKey, 16)
	try { $capAes.Encrypt($capNonce, $capPlaintext, $capCiphertext, $capTag, $capAad) } finally { $capAes.Dispose() }
	$capUpdated = @{ version = 1; wrappedKey = [Convert]::ToBase64String($capRsa.Encrypt($capAesKey, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)); nonce = [Convert]::ToBase64String($capNonce); ciphertext = [Convert]::ToBase64String($capCiphertext); tag = [Convert]::ToBase64String($capTag) }
	[IO.File]::WriteAllText($capSealedPath, ($capUpdated | ConvertTo-Json -Compress))
	@{ published = $true; origin = $capPayload.web.WEB_URL; backedUp = $true } | ConvertTo-Json
} finally {
	$capRsa.Dispose()
}
