@echo off
rem Media-encryption security harness. Run from anywhere (Windows, Node 22).
cd /d %~dp0\..\..
call node_modules\.bin\esbuild.cmd security\media\page.ts --bundle --format=iife --target=chrome120 --outfile=security\media\out\page.js --log-level=warning || exit /b 1
if exist security\media\out\userdata rmdir /s /q security\media\out\userdata
call node_modules\.bin\electron.cmd security\media\run.cjs live || exit /b 1
call node_modules\.bin\electron.cmd security\media\run.cjs mitm || exit /b 1
call node_modules\.bin\electron.cmd security\media\run.cjs cert cert-run1 || exit /b 1
call node_modules\.bin\electron.cmd security\media\run.cjs cert cert-run2 || exit /b 1
call node_modules\.bin\vitest.cmd run --root security\media || exit /b 1
