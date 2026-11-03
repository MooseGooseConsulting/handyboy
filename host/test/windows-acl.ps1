param([string]$Target, [switch]$Pipe)
$ErrorActionPreference = 'Stop'
if ($Pipe) {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $Target.Substring(9), [System.IO.Pipes.PipeDirection]::InOut)
    $client.Connect(5000)
    try { $acl = $client.GetAccessControl() } finally { $client.Dispose() }
} else { $acl = [System.IO.File]::GetAccessControl($Target) }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow') }
})
@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = $rules } | ConvertTo-Json -Compress -Depth 4
