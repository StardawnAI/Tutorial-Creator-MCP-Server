# Stores one credential for autologin, encrypted with Windows' own DPAPI - never as plain
# text on disk, and readable only by this Windows account on this machine.
#
# Run this yourself, in your own PowerShell window. The value you type is masked (not
# echoed) and is never sent anywhere - not to Claude, not to a chat, not into any .env file.
# Only the encrypted result is saved, to profiles\secrets\<Name>.dpapi.
#
#   powershell -File scripts\set-secret.ps1 -Name IG_PASSWORD_INSTAGRAM_CUSTOMER
#
# Name it exactly what autologin expects: IG_PASSWORD_<PROFILE> or IG_TOTP_SECRET_<PROFILE>,
# with the profile name upper-cased and any "-" turned into "_" (e.g. profile
# "instagram-customer" -> IG_PASSWORD_INSTAGRAM_CUSTOMER). Usernames are not secret (they
# are the public handle shown on the profile) and stay as plain IG_USERNAME_<PROFILE> in
# .env, same as before.

param(
    [Parameter(Mandatory = $true)]
    [string]$Name
)

$secretsDir = Join-Path $PSScriptRoot "..\profiles\secrets"
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

$secure = Read-Host -Prompt "Value for $Name (hidden, encrypted, never leaves this machine)" -AsSecureString
$cipher = ConvertFrom-SecureString $secure

$outFile = Join-Path $secretsDir "$Name.dpapi"
Set-Content -Path $outFile -Value $cipher -NoNewline -Encoding ascii

Write-Host "Saved, encrypted, to $outFile"
Write-Host "Only this Windows account on this machine can read it back."
