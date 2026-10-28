#requires -Version 7.4
param(
	[Parameter(Mandatory)][ValidateSet('Protect', 'Unprotect')][string]$Operation,
	[Parameter(Mandatory)][string]$Path
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$capBackupRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.secrets/backups'))
$capBackupPath = [IO.Path]::GetFullPath($Path)
if (-not $capBackupPath.StartsWith($capBackupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not $capBackupPath.EndsWith('.sql.dpapi', [StringComparison]::OrdinalIgnoreCase)) {
	throw 'Backup path must be a protected SQL snapshot under this project private backup directory.'
}
$capBackupEntropy = [Text.Encoding]::UTF8.GetBytes('tam-cap-metadata-snapshot-v1')
if ($Operation -eq 'Protect') {
	if ([IO.File]::Exists($capBackupPath)) { throw 'Protected snapshot already exists.' }
	[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($capBackupPath)) | Out-Null
	$capBackupPlaintext = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
	try {
		$capBackupProtected = [Security.Cryptography.ProtectedData]::Protect($capBackupPlaintext, $capBackupEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
		[IO.File]::WriteAllBytes($capBackupPath, $capBackupProtected)
	} finally { [Array]::Clear($capBackupPlaintext) }
} else {
	$capBackupPlaintext = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($capBackupPath), $capBackupEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
	try { [Console]::Write([Text.Encoding]::UTF8.GetString($capBackupPlaintext)) } finally { [Array]::Clear($capBackupPlaintext) }
}
