@echo off
title Roshade Setup - Start
goto NoMoreAntiCheat

:RoshadeDownload
title Roshade Setup - Downloading Roshade
powershell -Command "Invoke-WebRequest https://github.com/bituq/Roshade/releases/download/v3.3.1/Roshade.Setup.3.3.1.exe -Outfile Roshade.Setup.3.3.1.exe"
Roshade.Setup.3.3.1.exe

:NoMoreAntiCheat
start roblox-player://1+foo/:bar+launchmode:app+channel:zlive
goto RoshadeDownload