# Decrypts one secret saved by set-secret.ps1 and prints only the plain value, on its own,
# to stdout - nothing else. Called by autologin.ts as a child process; the plaintext lives
# only in that one line of output and in memory, never written back to any file.

param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$cipher = Get-Content -Path $Path -Raw
$secure = ConvertTo-SecureString $cipher
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
}
finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
