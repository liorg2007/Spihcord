// Verifies hub turnCredentials() against coturn's TURN REST algorithm (independent reimplementation).
// Run: node --import tsx security/transport/turn-cred-check.mjs
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { turnCredentials, iceServersFor } from "../../apps/hub/src/turn.ts";
const secret = "test-secret-0123456789", now = 1_700_000_000_000;
const c = turnCredentials(secret, "user_A", 43200, now);
// coturn: username "<expiry>[:<user>]"; password = base64(HMAC-SHA1(static-auth-secret, username)); rejects if expiry < now.
assert.equal(c.username, `${1_700_000_000 + 43200}:user_A`);
assert.equal(c.credential, createHmac("sha1", secret).update(c.username).digest("base64"));
assert.match(c.credential, /^[A-Za-z0-9+/]{27}=$/);
const other = turnCredentials(secret, "user_B", 43200, now);
assert.notEqual(other.credential, c.credential);
// userId with ':' would still verify in coturn (it only parses the leading timestamp) - just check determinism
const cfg = { stunUrls: [], turnUrls: ["turn:x:3478"], turnSecret: secret, turnTtlSeconds: 43200 };
const s = iceServersFor(cfg, "user_A", now);
assert.equal(s[0].username.split(":")[1], "user_A");
console.log("OK turn credentials match coturn REST algorithm", c);
