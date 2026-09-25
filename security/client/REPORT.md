# Desktop client and supply-chain security audit

Audited commit 67426c5 plus the uncommitted working tree, 2026-09-25. Evidence comes from runtime probes using `probe-main.mjs` and `read_fuses.py` in this folder.

Rerun:
```
npm run build -w @shpihcord/desktop
cd apps\desktop && npx electron ..\..\security\client\probe-main.mjs
python security/client/read_fuses.py apps/desktop/release/0.1.0/win-unpacked/Shpihcord.exe
```

| # | Check | Result | Severity |
|---|---|---|---|
| 1 | webPreferences | PASS | – |
| 2 | Electron fuses | **FAIL** | High |
| 3 | Auto-update integrity | **FAIL** | High |
| 4 | PTT recording usable as a global keylogger | **RISK** | Medium |
| 5 | Screen capture has no main-process consent step | RISK | Medium |
| 6 | Server URL defaults to cleartext http | RISK | Medium |
| 7 | CSP | PASS, with notes | Low |
| 8 | Navigation, window.open, openExternal | PASS | – |
| 9 | IPC | PASS (updater channels check the sender only) | Low |
| 10 | Permission handlers | PASS (not origin-scoped) | Low |
| 11 | Malicious hub → client | PASS (no size caps, so DoS is possible) | Low |
| 12 | Certificates and switches | PASS | – |
| 13 | Session storage | PASS (Linux `basic_text` backend gap) | Low |
| 14 | DevTools menu in production on macOS | RISK | Low |
| 15 | macOS entitlements too broad | RISK | Low |
| 16 | npm audit: 2 critical and 12 high, build-time only | RISK | Medium (build machine) |
| 17 | Lockfile sources | PASS | – |
| 18 | Native install scripts; better-sqlite3 downloads unhashed prebuilds | RISK | Medium |
| 19 | GitHub workflows | Not audited (they didn't exist yet at audit time) | – |
| 20 | Docker images not pinned by digest | RISK | Low |

## Key findings and fixes

**2. Fuses.**
- In the packaged exe, RunAsNode, NODE_OPTIONS and `--inspect` are enabled, and asar integrity plus OnlyLoadAppFromAsar are disabled.
- As a result, the exe can run arbitrary scripts. On macOS those scripts inherit the app's microphone, camera, screen recording and Accessibility permissions.
- Fix: upgrade to electron-builder ^26 and add to `electron-builder.yml`:
  ```yaml
  electronFuses:
    runAsNode: false
    enableCookieEncryption: true
    enableNodeOptionsEnvironmentVariable: false
    enableNodeCliInspectArguments: false
    enableEmbeddedAsarIntegrityValidation: true
    onlyLoadAppFromAsar: true
  ```

**3. Auto-update.**
- The build is unsigned and has no `publisherName`, so the only check on an update is the sha512 in `latest.yml`, which comes from the same GitHub release.
- In other words, anyone who can publish a release can push code to every client.
- Fixes:
  - Require 2FA, publish from CI through a protected environment, and keep releases as drafts.
  - Sign Windows builds and set `publisherName`.
  - Optionally, sign `latest.yml` with an Ed25519 key that the app checks.

**4. Push-to-talk.**
- Normal push-to-talk is safe: the page only ever learns whether the bound key is pressed.
- However, `ptt:record` (`ptt.ts:209`, `index.ts:183`) returns the next key pressed anywhere on the system, with no focus or gesture check. Called in a loop, it works as a keylogger.
- Fix: allow recording only while the window is focused, and cancel it on blur. Better: record keys with DOM `keydown` and keep the hook only for mouse buttons 4 and 5. Also rate-limit `ptt:setBinding`.

**5. Screen capture.**
- The source-id pattern is checked, but ids that were never listed are still accepted (`screen.ts:154-188`). There is also no `request.userGesture` check (`screen.ts:199`).
- Fix: require the user gesture, and require `lastSources.has(sourceId)`.

**6. Cleartext server URL.**
- `api.ts:19` turns a bare host into `http://`.
- Fix: default to https. Allow http only for loopback, LAN, `*.ts.net` and 100.64/10, or after the user confirms.

**Low-severity items:**
- Drop `blob:` from `script-src`, narrow `img-src`, and serve the app from an `app://` protocol instead of `file://`.
- Add the frame check to the updater IPC channels (`updater.ts:329`).
- Scope permissions by origin.
- On the client, drop hub frames over 4 MB and add `.max()` limits to the server schemas.
- Treat the Linux `basic_text` safeStorage backend as unencrypted.
- Remove DevTools in packaged builds (`platformSetup.ts:40`).
- Sign the native `.node` files and drop `disable-library-validation` and `allow-unsigned-executable-memory`.
- Pin Docker images by digest, and add `read_only`, `cap_drop` and `no-new-privileges`.
- In CI, run `npm ci --ignore-scripts` followed by an explicit rebuild. Build better-sqlite3 from source, or switch to `node:sqlite`.

## Passed with evidence
- **Window settings:** contextIsolation, sandbox and webSecurity are on, and there is no Node access in the page.
- **CSP:** eval, inline scripts and iframes are blocked.
- **External links:** `window.open` of `file:`, `smb:`, `ms-settings:` and `javascript:` is refused; only https reaches `openExternal`.
- **Rendering hub data:** no `dangerouslySetInnerHTML`, and every hub frame is validated with zod.
- **Certificates:** no certificate override.
- **Token storage:** the token is never in localStorage, and the session file is 0600 and encrypted.
- **Lockfile:** all 719 entries come from registry.npmjs.org with integrity hashes.
