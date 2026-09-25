@echo off
REM One-command runner for the hub security attack tests (Windows Node 22).
cd /d %~dp0\..\..
npx vitest run --config security/hub/vitest.config.ts
