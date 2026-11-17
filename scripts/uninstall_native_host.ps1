[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
# Intentionally fixed to one leaf key. Never remove NativeMessagingHosts or other hosts.
$keyPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.multichat.agent'
if (Test-Path -LiteralPath $keyPath) {
    if ($PSCmdlet.ShouldProcess($keyPath, 'Remove only the MCA Chrome native host registration')) {
        Remove-Item -LiteralPath $keyPath -ErrorAction Stop
        [PSCustomObject]@{ Removed = $true; RegistryKey = $keyPath }
    }
} else {
    [PSCustomObject]@{ Removed = $false; RegistryKey = $keyPath }
}
