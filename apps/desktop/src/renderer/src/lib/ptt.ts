/**
 * Push-to-talk: registers the binding with the main process' global hook
 * (uiohook-napi) and falls back to window-focused key/mouse events when the
 * global hook isn't available.
 */
import type { PttBinding } from "../../../shared/ipc";
import { getApp, setApp } from "../store/app";
import { getSettings, useSettings } from "../store/settings";
import { bridge } from "./bridge";
import { setPushToTalk } from "./voice";

const DOM_MOUSE_TO_CODE: Record<number, string> = { 1: "Mouse3", 3: "Mouse4", 4: "Mouse5" };

let recording = false;
let windowBinding: PttBinding | null = null;
let refreshSeq = 0;

function setActive(active: boolean): void {
  if (getApp().pttActive === active) return;
  setApp({ pttActive: active });
  setPushToTalk(active);
}

// --- window fallback -------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  if (windowBinding && e.code === windowBinding.code && !e.repeat) setActive(true);
}
function onKeyUp(e: KeyboardEvent): void {
  if (windowBinding && e.code === windowBinding.code) setActive(false);
}
function onMouseDown(e: MouseEvent): void {
  if (windowBinding && DOM_MOUSE_TO_CODE[e.button] === windowBinding.code) setActive(true);
}
function onMouseUp(e: MouseEvent): void {
  if (windowBinding && DOM_MOUSE_TO_CODE[e.button] === windowBinding.code) setActive(false);
}
function onBlur(): void {
  // We can't see the key-up once focus is gone.
  if (windowBinding) setActive(false);
}

function attachWindow(binding: PttBinding | null): void {
  const had = !!windowBinding;
  windowBinding = binding;
  if (binding && !had) {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", onBlur);
  } else if (!binding && had) {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("blur", onBlur);
  }
}

// --- registration ------------------------------------------------------------

async function refresh(): Promise<void> {
  const seq = ++refreshSeq;
  const { inputMode, pttBinding } = getSettings();
  const want = inputMode === "push-to-talk" && pttBinding && !recording ? pttBinding : null;
  setActive(false);
  let global = false;
  try {
    const res = await bridge.ptt.setBinding(want);
    global = res.global;
    if (want && !res.global && res.reason) console.info("[ptt] global hook not used:", res.reason);
  } catch (err) {
    console.warn("[ptt] setBinding failed", err);
  }
  if (seq !== refreshSeq) return;
  setApp({ pttGlobal: !!want && global });
  attachWindow(want && !global ? want : null);
}

let initialized = false;
export function initPtt(): void {
  if (initialized) return;
  initialized = true;
  bridge.ptt.onState((pressed) => setActive(pressed));
  useSettings.subscribe((s, prev) => {
    if (s.inputMode !== prev.inputMode || s.pttBinding?.code !== prev.pttBinding?.code) void refresh();
  });
  void refresh();
}

/** Pause PTT while the settings modal records a new keybind. */
export function setPttRecording(on: boolean): void {
  if (recording === on) return;
  recording = on;
  void refresh();
}

/** Human label for a DOM KeyboardEvent. */
export function bindingFromKeyboardEvent(e: KeyboardEvent): PttBinding {
  const code = e.code || e.key;
  let label = code;
  if (code.startsWith("Key")) label = code.slice(3);
  else if (code.startsWith("Digit")) label = code.slice(5);
  else if (e.key.length === 1 && e.key !== " ") label = e.key.toUpperCase();
  else if (code === "Space") label = "Space";
  else label = code.replace(/Left$/, "").replace(/Right$/, " (R)").replace(/^Control/, "Ctrl");
  return { code, label };
}

export function bindingFromMouseEvent(e: MouseEvent): PttBinding | null {
  const code = DOM_MOUSE_TO_CODE[e.button];
  if (!code) return null;
  return { code, label: code === "Mouse3" ? "Middle Mouse" : code.replace("Mouse", "Mouse ") };
}
