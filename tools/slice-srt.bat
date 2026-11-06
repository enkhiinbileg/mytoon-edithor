@echo off
chcp 65001 > nul
node "%~dp0slice-srt.cjs" %*
if "%~1"=="" pause
