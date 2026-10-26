@echo off
rem model-router installer, Windows. Double-click = menu. With args = run directly, e.g.
rem   setup.cmd install --rules=clean,check      setup.cmd uninstall      setup.cmd install --dry-run
rem Keep this file ASCII and CRLF: cmd.exe reads .cmd files in the console code page. All Chinese text is printed by setup.js.
where node >nul 2>nul || (echo Node.js not found. Install Node.js 18+ from https://nodejs.org and run this again. & pause & exit /b 1)
set "MR_P="
if "%~1"=="" set "MR_P=--pause"
rem Uninstall may delete this file and its folder while it runs; plain "exit /b" would re-open it and print "path not found".
rem "(goto) 2>nul" leaves the batch without re-reading it, MR_RC carries node's exit code past it. No setlocal: it would drop MR_RC.
node "%~dp0setup.js" %MR_P% %* & call set "MR_RC=%%errorlevel%%" & (goto) 2>nul & call cmd /c exit %%MR_RC%%
