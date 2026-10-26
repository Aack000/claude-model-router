# model-router installer, PowerShell. Right-click > "Run with PowerShell" = menu. With args = run directly, e.g.
#   .\setup.ps1 install --rules=clean,check      .\setup.ps1 uninstall      .\setup.ps1 install --dry-run
# If scripts are blocked by execution policy: powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page. All Chinese text is printed by setup.js.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js not found. Install Node.js 18+ from https://nodejs.org and run this again.'
  if ($args.Count -eq 0) { cmd /c pause }
  exit 1
}
# Run node from the home folder: when launched from the plugin folder it is the current directory, and Windows cannot delete a directory that is in use (uninstall's last step).
# Push-Location, not Set-Location: the caller's own current directory must come back. Pop-Location fails quietly if that folder was just deleted.
# The PowerShell process itself also holds its start directory (Push-Location only moves the PowerShell location), so move and restore that too.
$oldCwd = [Environment]::CurrentDirectory
Push-Location -LiteralPath $HOME
try {
  [Environment]::CurrentDirectory = $HOME
  if ($args.Count -eq 0) { node "$PSScriptRoot/setup.js" --pause } else { node "$PSScriptRoot/setup.js" @args }
  $rc = $LASTEXITCODE
} finally {
  try { [Environment]::CurrentDirectory = $oldCwd } catch { }
  Pop-Location -ErrorAction SilentlyContinue
}
exit $rc
