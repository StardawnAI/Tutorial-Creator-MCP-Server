# Stores one credential for autologin, encrypted with Windows' own DPAPI - never as plain
# text on disk, and readable only by this Windows account on this machine.
#
# Run this yourself, in your own PowerShell window. The value you type is masked (not
# echoed) and is never sent anywhere - not to Claude, not to a chat, not into any .env file.
# Only the encrypted result is saved, to profiles\secrets\<Name>.dpapi.
#
#   powershell -File scripts\set-secret.ps1 -Name IG_PASSWORD_INSTAGRAM_CUSTOMER
#
# Name it exactly what autologin expects: <SITE>_PASSWORD_<PROFILE> or
# <SITE>_TOTP_SECRET_<PROFILE> (SITE is IG for Instagram, FB for Facebook), with the profile
# name upper-cased and any "-" turned into "_" (e.g. profile "instagram-customer" ->
# IG_PASSWORD_INSTAGRAM_CUSTOMER). A username that is a public handle stays a plain
# <SITE>_USERNAME_<PROFILE> in .env; one that is a private e-mail address or phone number
# (a Facebook login, usually) is stored here the same way, e.g. FB_USERNAME_INSTAR_REVIEW.

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
