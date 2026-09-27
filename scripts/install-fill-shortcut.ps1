param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$NodeExe
)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'fill-ds160.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $NodeExe
$shortcut.Arguments = 'scripts\fill-ui\server.js --open'
$shortcut.WorkingDirectory = $Repo
$shortcut.WindowStyle = 7
$shortcut.Description = 'fill-ds160'
$shortcut.Save()

if (-not (Test-Path -LiteralPath $lnk)) {
  throw "Shortcut was not created at $lnk"
}

Write-Host "Shortcut created: $lnk"
Write-Host "Double-click fill-ds160 on the Desktop."
