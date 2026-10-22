[CmdletBinding()]
param(
    [string]$ExtensionId,
    [switch]$Dev,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Handyboy\native'),
    [string]$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.handyboy.host'
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Use host/install.sh outside Windows.' }
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ExtensionId) {
    $source = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'wxt.config.ts'))
    $key = [regex]::Match($source, "'(?<key>MII[A-Za-z0-9+/=]+)'").Groups['key'].Value
    if (-not $key) { throw 'No pinned extension key found; pass -ExtensionId.' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([Convert]::FromBase64String($key)) } finally { $sha.Dispose() }
    $ExtensionId = -join ($hash[0..15] | ForEach-Object {
        [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15))
    })
}
if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'ExtensionId must be 32 lowercase letters a-p.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = [version]((& $node --version).Trim().TrimStart('v'))
if ($version -lt [version]'22.18.0') { throw 'Node 22.18 or newer is required to run the TypeScript host.' }
$doppler = Get-Command doppler.exe -ErrorAction SilentlyContinue
$InstallDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
$entry = Join-Path $PSScriptRoot 'src\main.ts'
$dopplerDir = if ($doppler) { Split-Path $doppler.Source -Parent } else { '' }
foreach ($value in @($node, $entry, $InstallDirectory, $dopplerDir)) {
    # cmd.exe expands percent variables even inside quotes. Never write an
    # executable launcher whose path can change meaning when Chrome invokes it.
    if ($value -match '[%"\r\n]') { throw 'Launcher paths cannot contain percent signs, quotes, or newlines.' }
}
[System.IO.Directory]::CreateDirectory($InstallDirectory) | Out-Null
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'windows\private-acl.ps1') -Target $InstallDirectory
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the installation directory.' }
$utf8 = [System.Text.UTF8Encoding]::new($false)
$launcher = Join-Path $InstallDirectory 'handyboy-host.cmd'
$lines = @('@echo off', 'setlocal DisableDelayedExpansion')
if ($Dev) { $lines += 'set "HANDYBOY_DEV=1"' }
if ($dopplerDir) { $lines += 'set "PATH=' + $dopplerDir + ';%PATH%"' }
$lines += '"' + $node + '" "' + $entry + '" %*'
[System.IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", $utf8)
$manifestPath = Join-Path $InstallDirectory 'com.handyboy.host.json'
$manifest = @{
    name = 'com.handyboy.host'
    description = 'Handyboy native host'
    path = $launcher
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
if (Test-Path -LiteralPath $RegistryPath) {
    $previous = (Get-Item -LiteralPath $RegistryPath).GetValue('')
    if ($previous -and $previous -ne $manifestPath) {
        [System.IO.File]::WriteAllText((Join-Path $InstallDirectory ('registration-backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.json')),
            (@{ registryPath = $RegistryPath; manifestPath = $previous } | ConvertTo-Json), $utf8)
    }
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -LiteralPath $RegistryPath -Value $manifestPath
Write-Output "Registered Handyboy for Chrome: $manifestPath"
Write-Output "Extension ID: $ExtensionId; Node: $version; dev: $($Dev.IsPresent)"
Write-Output "Load $repoRoot\.output\chrome-mv3 at chrome://extensions, then open the Handyboy side panel."
