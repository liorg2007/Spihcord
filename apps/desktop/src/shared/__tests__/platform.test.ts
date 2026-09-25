import { describe, expect, it } from "vitest";
import { darwinMajor, isWaylandSession, mergeFeatures, modifierLabel, platformCaps, windowsBuild } from "../platform";

describe("platformCaps", () => {
  it("Windows 11: everything, app audio when the pid resolver loads", () => {
    const c = platformCaps("win32", {}, "10.0.22631");
    expect(c).toMatchObject({ systemAudio: true, excludeOwnAudio: true, appAudio: true, globalPtt: true, sourcePicker: "custom", modKey: "Ctrl" });
    expect(c.audioNote).toBeUndefined();
    expect(platformCaps("win32", {}, "10.0.22631", { pidResolver: false }).appAudio).toBe(false);
  });
  it("Windows 10 22H2 excludes own audio but no app audio; older builds warn", () => {
    expect(platformCaps("win32", {}, "10.0.19045")).toMatchObject({ excludeOwnAudio: true, appAudio: false });
    const old = platformCaps("win32", {}, "10.0.19044");
    expect(old.excludeOwnAudio).toBe(false);
    expect(old.audioNote).toMatch(/Update Windows/);
  });
  it("macOS 13+ gets system audio without own audio; older is hidden", () => {
    const c = platformCaps("darwin", {}, "23.4.0");
    expect(c).toMatchObject({ systemAudio: true, excludeOwnAudio: true, appAudio: false, globalPtt: true, needsAccessibility: true, needsScreenPermission: true, modKey: "Cmd", sourcePicker: "custom" });
    expect(platformCaps("darwin", {}, "21.6.0")).toMatchObject({ systemAudio: false, excludeOwnAudio: false });
  });
  it("Linux X11: custom picker, global PTT, audio includes voice chat", () => {
    const c = platformCaps("linux", { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" }, "6.8.0");
    expect(c).toMatchObject({ wayland: false, sourcePicker: "custom", globalPtt: true, systemAudio: true, excludeOwnAudio: false, appAudio: false });
    expect(c.audioNote).toMatch(/hear themselves/);
  });
  it("Linux Wayland: portal picker, no global PTT", () => {
    for (const env of [{ XDG_SESSION_TYPE: "wayland" }, { WAYLAND_DISPLAY: "wayland-0" }]) {
      expect(platformCaps("linux", env, "6.8.0")).toMatchObject({ wayland: true, sourcePicker: "system", globalPtt: false });
    }
  });
  it("unknown platforms get nothing", () => {
    expect(platformCaps("browser", {}, "")).toMatchObject({ systemAudio: false, globalPtt: false, appAudio: false });
  });
});

describe("helpers", () => {
  it("parses OS releases", () => {
    expect(windowsBuild("10.0.19045")).toBe(19045);
    expect(windowsBuild("garbage")).toBe(0);
    expect(darwinMajor("22.1.0")).toBe(22);
  });
  it("detects Wayland", () => {
    expect(isWaylandSession({})).toBe(false);
    expect(isWaylandSession({ XDG_SESSION_TYPE: "Wayland" })).toBe(true);
    expect(isWaylandSession({ XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "w" })).toBe(true);
  });
  it("merges --enable-features without duplicates", () => {
    expect(mergeFeatures(undefined, ["A"])).toBe("A");
    expect(mergeFeatures("", ["A"])).toBe("A");
    expect(mergeFeatures("X, A", ["A", "B"])).toBe("X,A,B");
  });
  it("labels modifiers per platform", () => {
    expect(modifierLabel("MetaLeft", "darwin")).toBe("Cmd");
    expect(modifierLabel("AltRight", "darwin")).toBe("Option (R)");
    expect(modifierLabel("MetaLeft", "win32")).toBe("Win");
    expect(modifierLabel("MetaLeft", "linux")).toBe("Super");
    expect(modifierLabel("ControlLeft", "linux")).toBe("Ctrl");
    expect(modifierLabel("KeyA", "linux")).toBeNull();
  });
});
