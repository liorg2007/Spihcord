# Media encryption audit (2026-09-25)

Rerun everything with `cmd.exe /c "C:\Users\User\Desktop\Shpihcord\security\media\run.bat"`. Evidence is written to `out/*.json`.

| # | Check | Result | Severity |
|---|---|---|---|
| 1 | All media is DTLS-SRTP over BUNDLE | PASS | Info |
| 2 | SDP munging keeps security lines intact | PASS | Info |
| 3a | A malicious hub can MITM all media by substituting fingerprints | **FAIL** | **High** |
| 3b | A mid-call fingerprint change is accepted silently | **FAIL** | **High** |
| 3c | TOFU certificate pinning is feasible | PASS (tested) | – |
| 4 | Certificate and cipher strength | PASS, with Low notes | Low |
| 5 | Metadata leakage (hub, TURN, DTX/VAD) | RISK (inherent) | Low/Info |

## 1. DTLS-SRTP: PASS
Tested in a live 3-peer call with voice, screen share (video + system audio) and a camera track.
- All 6 directed pairs connected over one bundled transport per connection.
- DTLS 1.3 (FEFC) with `TLS_AES_128_GCM_SHA256`, and SRTP with `AES128_CM_HMAC_SHA1_80`.
- Every m-line was UDP/TLS/RTP/SAVPF.
- Certificates were ECDSA P-256 with sha-256 fingerprints.
- Downgrade probes: an offer with no fingerprint is rejected and SDES `a=crypto` is rejected, so there is no plaintext path.

## 2. SDP munging: PASS
`sdp-munge.test.ts` runs 9 transform variants over 21 real SDPs, with 2,000 random mutations per variant. It asserts that:
- the fingerprint, setup, ice, BUNDLE, mid, m=, c=, candidate and crypto lines stay byte-identical;
- only `a=fmtp` lines change;
- no `RTP/AVP` appears.

Result: 20/20 passed. If a munged SDP is rejected, `peer.ts:287-290` falls back to the unmodified SDP, which is safe.

## 3a. Hub MITM: FAIL (High)
The `run.cjs mitm` proof of concept puts a relay between two peers that each run the real engine `Peer`. The relay answers each side with its own certificate.
- Both sides report connected over DTLS 1.3, and each sees the relay's fingerprint.
- The relay decoded Alice's mic (peak 1.0) and forwarded it to Bob (peak 1.0, 336 packets).
- No error and no reset were raised on either side.

Root cause: nothing binds `a=fingerprint` to a user's identity. TURN cannot carry out this attack; only whoever controls signaling can.

## 3b. Silent key change mid-call: FAIL (High)
When a fingerprint change arrives, `peer.ts:168-173` and `302-306` call `requestReset("remote-restarted")`. `voiceCall.ts:478-486` then recreates the peer and replays the attacker's offer, with no warning. The proof of concept injected a new fingerprint mid-call, and the call switched to it with 0 errors.

## 3c. Mitigations
- **(a) Safety numbers:** a hash of both DTLS fingerprints shown on each peer tile. This is cheap, but it only means something once certificates are stable, which needs (c).
- **(b) SFrame / Insertable Streams E2EE:** the highest effort (key management, a worker per stream, CPU cost at 1440p60). It still needs identity verification, and it becomes required if an SFU is ever added.
- **(c) TOFU pinning of a long-term per-user certificate:** tested and works. A certificate persisted in IndexedDB survives an Electron restart with the same fingerprint. Implementation:
  1. Pass `certificates:[cert]` in `rtcConfig()` (`voiceCall.ts:374-384`). **Pitfall:** `setConfiguration` (`voiceCall.ts:237`) must pass the same certificate object, or Chromium throws `InvalidModificationError`.
  2. Load or create the certificate in the renderer (ECDSA P-256), and regenerate it before it expires.
  3. Add a `verifyFingerprint(userId, fp)` hook in `Peer.handleSignal` (`peer.ts:163`) that runs before `setRemoteDescription`:
     - no pin yet: store it;
     - match: proceed;
     - mismatch: warn and block media until the user confirms.

     Check every `a=fingerprint` line, not only the first (`sdp.ts:108`).
  4. Send `remote-restarted` through the same check.
  5. Show safety numbers in the UI.

## 4. Crypto strength: PASS (Low notes)
- DTLS 1.3 with AEAD and ECDHE. Default certificates are replaced on every connection, which gives forward secrecy.
- **Low:** SRTP uses AES-CM with HMAC-SHA1-80 rather than GCM. This can't be changed from JavaScript.
- **Low:** Chromium accepts RSA-1024 certificates and sha-1 fingerprints. Once pinning exists, pin ECDSA P-256 and sha-256 only.

## 5. Metadata: RISK (inherent)
- **The hub** sees:
  - who is in which channel and when;
  - the full SDP, which includes everyone's IPs;
  - when people start and stop sharing their screen or camera.
- **Anyone on the network path, including TURN,** can tell who is speaking and when:
  - Mic DTX (`usedtx=1`) and variable-bitrate Opus make packet sizes and timing reveal it.
  - The `ssrc-audio-level` RTP header extension is sent unencrypted.
- **Optional privacy mode:** constant bitrate (`cbr=1`) with DTX off (`usedtx=0`), plus stripping the `ssrc-audio-level` extension.
