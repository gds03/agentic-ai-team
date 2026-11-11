@echo off
rem Opens the backlog board and the docs viewer in the browser, both in this one window.
rem Close the window (or press Ctrl+C) to stop both. Needs Node 18+ on the PATH.
cd /d "%~dp0"
start "" /b node tools\board.mjs --watch --open
node tools\docs.mjs --open
