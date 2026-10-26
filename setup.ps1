# model-router installer, PowerShell. Right-click > "Run with PowerShell" = menu. With args = run directly, e.g.
#   .\setup.ps1 install --rules=clean,check      .\setup.ps1 uninstall      .\setup.ps1 install --dry-run
# If scripts are blocked by execution policy: powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page. All Chinese text is printed by setup.js.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js not found. Install Node.js 18+ from https://nodejs.org and run this again.'
  if ($args.Count -eq 0) { cmd /c pause }
  exit 1
}
if ($args.Count -eq 0) { node "$PSScriptRoot/setup.js" --pause } else { node "$PSScriptRoot/setup.js" @args }
exit $LASTEXITCODE
