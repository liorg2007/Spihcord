import { describe, expect, it } from "vitest";
import { webrtcPolicyForHub } from "../../main/webrtcPolicy";
import { classifyHost, needsCleartextConsent, normalizeServerUrl } from "../serverUrl";

describe("classifyHost", () => {
  it.each([
    ["localhost", "loopback"],
    ["LOCALHOST.", "loopback"],
    ["app.localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["127.255.1.2", "loopback"],
    ["[::1]", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.203", "private"],
    ["169.254.10.10", "private"],
    ["100.64.0.1", "private"],
    ["100.87.127.21", "private"],
    ["100.127.255.255", "private"],
    ["[fd7a:115c:a1e0::1]", "private"],
    ["fc00::1", "private"],
    ["fe80::1%eth0", "private"],
    ["[::ffff:192.168.0.1]", "private"],
    ["nas.local", "private"],
    ["hub.tail1234.ts.net", "private"],
    ["172.15.0.1", "public"],
    ["172.32.0.1", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["8.8.8.8", "public"],
    ["192.169.0.1", "public"],
    ["[2a0d:6fc2:4850:7b00::1]", "public"],
    ["::ffff:8.8.8.8", "public"],
    ["chat.example.com", "public"],
    ["local", "public"],
    ["evil-ts.net", "public"],
    ["localhost.evil.com", "public"],
    ["10.0.0.1.evil.com", "public"],
    ["999.1.1.1", "public"],
    ["", "public"],
  ])("%s -> %s", (host, want) => {
    expect(classifyHost(host)).toBe(want);
  });
});

describe("normalizeServerUrl", () => {
  it("bare public hosts default to https", () => {
    expect(normalizeServerUrl("chat.example.com")).toBe("https://chat.example.com");
    expect(normalizeServerUrl(" chat.example.com:8443/ ")).toBe("https://chat.example.com:8443");
  });
  it("bare local/LAN/Tailscale hosts default to http", () => {
    expect(normalizeServerUrl("localhost:8420")).toBe("http://localhost:8420");
    expect(normalizeServerUrl("192.168.1.5:8420")).toBe("http://192.168.1.5:8420");
    expect(normalizeServerUrl("hub.tail1.ts.net:8420")).toBe("http://hub.tail1.ts.net:8420");
  });
  it("keeps explicit schemes and maps ws(s) to http(s)", () => {
    expect(normalizeServerUrl("http://chat.example.com")).toBe("http://chat.example.com");
    expect(normalizeServerUrl("wss://chat.example.com/sub/")).toBe("https://chat.example.com/sub");
    expect(normalizeServerUrl("ws://10.0.0.2:8420")).toBe("http://10.0.0.2:8420");
  });
  it("rejects other schemes, credentials and junk", () => {
    expect(() => normalizeServerUrl("")).toThrow();
    expect(() => normalizeServerUrl("ftp://x")).toThrow();
    expect(() => normalizeServerUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeServerUrl("https://user:pw@x.com")).toThrow();
    expect(() => normalizeServerUrl("http://")).toThrow();
  });
});

describe("needsCleartextConsent", () => {
  it("https never needs consent", () => {
    expect(needsCleartextConsent("https://chat.example.com")).toBe(false);
  });
  it("http to local/LAN/Tailscale doesn't", () => {
    for (const u of ["http://localhost:8420", "http://192.168.1.2", "http://100.100.1.1:8420", "http://nas.local", "http://[fe80::1]"]) {
      expect(needsCleartextConsent(u)).toBe(false);
    }
  });
  it("http/ws to a public host does", () => {
    expect(needsCleartextConsent("http://chat.example.com")).toBe(true);
    expect(needsCleartextConsent("ws://8.8.8.8")).toBe(true);
    expect(needsCleartextConsent("http://[2a0d::1]")).toBe(true);
    expect(needsCleartextConsent("not a url")).toBe(true);
  });
});

describe("webrtcPolicyForHub", () => {
  it("is strict by default and for public hubs", () => {
    expect(webrtcPolicyForHub(null)).toBe("default_public_interface_only");
    expect(webrtcPolicyForHub("https://chat.example.com")).toBe("default_public_interface_only");
    expect(webrtcPolicyForHub("garbage")).toBe("default_public_interface_only");
  });
  it("allows all interfaces for loopback/LAN/Tailscale hubs", () => {
    expect(webrtcPolicyForHub("http://localhost:8420")).toBe("default");
    expect(webrtcPolicyForHub("http://192.168.1.5:8420")).toBe("default");
    expect(webrtcPolicyForHub("https://hub.tail1.ts.net")).toBe("default");
  });
});
