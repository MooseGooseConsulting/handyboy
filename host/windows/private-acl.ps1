param(
    [Parameter(Mandatory)][string]$Target,
    [ValidateSet('directory')][string]$Kind = 'directory'
)
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Kind -eq 'directory') {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid, 'S-1-5-18')) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.SecurityIdentifier]::new($identity),
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [System.IO.Directory]::SetAccessControl($Target, $acl)
    exit
}

