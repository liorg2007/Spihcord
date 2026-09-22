import { useCallback, useEffect, useRef, useState } from "react";
import type { PttBinding } from "../../../shared/ipc";
import { bridge } from "../lib/bridge";
import { hostOf } from "../lib/format";
import { startMicTest } from "../lib/micTest";
import { bindingFromKeyboardEvent, bindingFromMouseEvent, setPttRecording } from "../lib/ptt";
import { logout } from "../lib/session";
import { setApp, useApp } from "../store/app";
import { useSettings, type Settings } from "../store/settings";
import { Avatar } from "./Avatar";
import { KeyboardIcon, LogOutIcon, MicIcon, ShieldIcon, XIcon } from "./Icons";

type Tab = "voice" | "account";

export function SettingsModal() {
  const [tab, setTab] = useState<Tab>("voice");
  const [version, setVersion] = useState("");
  const close = useCallback(() => setApp({ settingsOpen: false }), []);

  useEffect(() => {
    void bridge.getVersion().then(setVersion).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.body.dataset.recordingKeybind) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="settings-layer" role="dialog" aria-modal="true" aria-label="User Settings">
      <div className="settings-nav-wrap">
        <nav className="settings-nav">
          <div className="settings-nav-heading">User Settings</div>
          <button className={`settings-nav-item${tab === "account" ? " selected" : ""}`} onClick={() => setTab("account")}>
            My Account
          </button>
          <div className="settings-nav-heading">App Settings</div>
          <button className={`settings-nav-item${tab === "voice" ? " selected" : ""}`} onClick={() => setTab("voice")}>
            Voice &amp; Audio
          </button>
          <div className="settings-nav-sep" />
          <button className="settings-nav-item danger" onClick={() => void logout()}>
            Log Out <LogOutIcon size={16} />
          </button>
          <div className="settings-version">
            Shpihcord {version || "…"} · {bridge.platform}
          </div>
        </nav>
      </div>
      <div className="settings-content-wrap">
        <div className="settings-content">{tab === "voice" ? <VoiceSettings /> : <AccountSettings />}</div>
        <div className="settings-close">
          <button className="close-circle" onClick={close} aria-label="Close settings">
            <XIcon size={18} />
          </button>
          <span>ESC</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AccountSettings() {
  const self = useApp((s) => s.self ?? s.session?.user ?? null);
  const serverUrl = useApp((s) => s.session?.serverUrl ?? "");
  const connection = useApp((s) => s.connection);
  if (!self) return null;
  return (
    <section>
      <h2 className="settings-title">My Account</h2>
      <div className="account-card">
        <div className="account-banner" />
        <div className="account-body">
          <div className="account-avatar">
            <Avatar userId={self.id} name={self.displayName || self.username} size={80} />
          </div>
          <div className="account-names">
            <div className="account-name">{self.displayName || self.username}</div>
            <div className="muted">@{self.username}</div>
          </div>
        </div>
        <div className="account-fields">
          <div className="account-field">
            <div className="field-label">Server</div>
            <div>{hostOf(serverUrl)}</div>
          </div>
          <div className="account-field">
            <div className="field-label">Status</div>
            <div className="capitalize">{connection}</div>
          </div>
        </div>
      </div>
      <button className="btn btn-danger" onClick={() => void logout()}>
        Log Out
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function useDevices(): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((d) => {
          if (alive) setDevices(d);
        })
        .catch(() => {});
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    // Labels appear once mic access was granted (the mic test does that); refresh shortly after.
    const t = setTimeout(refresh, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, []);
  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
  };
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
  fallbackName,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
  fallbackName: string;
}) {
  const hasDefault = devices.some((d) => d.deviceId === "default");
  const known = value === "default" || devices.some((d) => d.deviceId === value);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {!hasDefault && <option value="default">Default</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${fallbackName} ${i + 1}`}
            </option>
          ))}
          {!known && <option value={value}>Unavailable device</option>}
        </select>
      </div>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description?: string;
}) {
  return (
    <label className="toggle-row">
      <div className="toggle-text">
        <div className="toggle-title">{title}</div>
        {description && <div className="toggle-desc">{description}</div>}
      </div>
      <input type="checkbox" className="toggle-input" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}

function VoiceSettings() {
  const s = useSettings();
  const inCall = useApp((st) => !!st.voiceChannelId);
  const { inputs, outputs } = useDevices();
  const update = (patch: Partial<Settings>) => s.update(patch);

  return (
    <section>
      <h2 className="settings-title">Voice &amp; Audio</h2>

      <div className="settings-grid-2">
        <DeviceSelect
          label="Input Device"
          devices={inputs}
          value={s.inputDeviceId}
          onChange={(id) => update({ inputDeviceId: id })}
          fallbackName="Microphone"
        />
        <DeviceSelect
          label="Output Device"
          devices={outputs}
          value={s.outputDeviceId}
          onChange={(id) => update({ outputDeviceId: id })}
          fallbackName="Speaker"
        />
      </div>

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Input Mode</h3>
      <div className="radio-cards">
        <label className={`radio-card${s.inputMode === "voice-activity" ? " selected" : ""}`}>
          <input
            type="radio"
            name="inputMode"
            checked={s.inputMode === "voice-activity"}
            onChange={() => update({ inputMode: "voice-activity" })}
          />
          <MicIcon size={18} />
          <span>Voice Activity</span>
        </label>
        <label className={`radio-card${s.inputMode === "push-to-talk" ? " selected" : ""}`}>
          <input
            type="radio"
            name="inputMode"
            checked={s.inputMode === "push-to-talk"}
            onChange={() => update({ inputMode: "push-to-talk" })}
          />
          <KeyboardIcon size={18} />
          <span>Push to Talk</span>
        </label>
      </div>

      {s.inputMode === "push-to-talk" && <KeybindRecorder binding={s.pttBinding} onChange={(b) => update({ pttBinding: b })} />}

      <h3 className="settings-subtitle">Input Sensitivity</h3>
      <p className="settings-hint">
        {s.inputMode === "voice-activity"
          ? "Drag the marker: your mic transmits when the level is past it. Talk to test."
          : "In Push to Talk mode the mic only transmits while the key is held. The meter shows your level."}
      </p>
      <MicMeter threshold={s.vadThreshold} onThreshold={(v) => update({ vadThreshold: v })} showThreshold={s.inputMode === "voice-activity"} />

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Voice Processing</h3>
      {inCall && <p className="settings-hint">Processing changes apply the next time you join a voice channel.</p>}
      <Toggle
        title="Noise Suppression"
        description="Filters out background noise like fans and keyboards."
        checked={s.noiseSuppression}
        onChange={(v) => update({ noiseSuppression: v })}
      />
      <Toggle
        title="Echo Cancellation"
        description="Stops others from hearing themselves through your speakers."
        checked={s.echoCancellation}
        onChange={(v) => update({ echoCancellation: v })}
      />
      <Toggle
        title="Automatic Gain Control"
        description="Keeps your volume steady whether you whisper or shout."
        checked={s.autoGainControl}
        onChange={(v) => update({ autoGainControl: v })}
      />

      <div className="settings-divider" />

      <h3 className="settings-subtitle">
        <ShieldIcon size={16} /> Privacy
      </h3>
      <Toggle
        title="Hide my IP (force relay)"
        description="Route voice through the server's TURN relay so friends can't see your IP address. May add latency. Applies the next time you join."
        checked={s.forceRelay}
        onChange={(v) => update({ forceRelay: v })}
      />

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Sounds</h3>
      <Toggle
        title="Join, leave and mute sounds"
        checked={s.soundsEnabled}
        onChange={(v) => update({ soundsEnabled: v })}
      />
    </section>
  );
}

function MicMeter({
  threshold,
  onThreshold,
  showThreshold,
}: {
  threshold: number;
  onThreshold: (v: number) => void;
  showThreshold: boolean;
}) {
  const fillRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const showRef = useRef(showThreshold);
  showRef.current = showThreshold;

  useEffect(() => {
    setError(null);
    const stop = startMicTest(
      (level) => {
        const el = fillRef.current;
        if (!el) return;
        el.style.width = `${Math.round(level * 1000) / 10}%`;
        el.classList.toggle("active", !showRef.current || level >= thresholdRef.current);
      },
      (msg) => setError(msg),
    );
    return stop;
  }, []);

  const pct = Math.round(threshold * 100);
  return (
    <div className="meter-block">
      <div className={`meter${showThreshold ? "" : " no-threshold"}`}>
        <div className="meter-fill" ref={fillRef} />
        {showThreshold && (
          <input
            type="range"
            className="meter-slider"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => onThreshold(Number(e.target.value) / 100)}
            aria-label="Voice activity threshold"
          />
        )}
      </div>
      <div className="meter-scale">
        <span>-60 dB</span>
        {showThreshold && <span>threshold {Math.round(-60 + threshold * 60)} dB</span>}
        <span>0 dB</span>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function KeybindRecorder({ binding, onChange }: { binding: PttBinding | null; onChange: (b: PttBinding) => void }) {
  const [recording, setRecording] = useState(false);
  const pttGlobal = useApp((s) => s.pttGlobal);
  const [globalAvailable, setGlobalAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    void bridge.ptt.isGlobalAvailable().then(setGlobalAvailable).catch(() => setGlobalAvailable(false));
  }, []);

  useEffect(() => {
    if (!recording) return;
    let done = false;
    document.body.dataset.recordingKeybind = "1";
    setPttRecording(true);
    const finish = (b: PttBinding | null) => {
      if (done) return;
      done = true;
      setRecording(false);
      if (b && b.code !== "Escape") onChange(b);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finish(e.code === "Escape" ? null : bindingFromKeyboardEvent(e));
    };
    const onMouse = (e: MouseEvent) => {
      const b = bindingFromMouseEvent(e);
      if (!b) return;
      e.preventDefault();
      finish(b);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    // Also listen system-wide, so keys the window can't see (e.g. while unfocused) work too.
    void bridge.ptt.record(15000).then((b) => {
      if (b) finish(b);
      else if (!done && globalAvailable) finish(null); // global recorder timed out
    });
    const timeout = setTimeout(() => finish(null), 15000);
    return () => {
      done = true;
      clearTimeout(timeout);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      bridge.ptt.cancelRecord();
      delete document.body.dataset.recordingKeybind;
      setPttRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <div className="keybind">
      <div className="field-label">Shortcut</div>
      <div className={`keybind-box${recording ? " recording" : ""}`}>
        <span className="keybind-key">{recording ? "Press a key or mouse button…" : (binding?.label ?? "Not set")}</span>
        <button className={`btn ${recording ? "btn-danger" : "btn-secondary"} btn-small`} onClick={() => setRecording((r) => !r)}>
          {recording ? "Cancel" : "Record Keybind"}
        </button>
      </div>
      <p className="settings-hint">
        {globalAvailable === false
          ? "Global hotkeys aren't available on this system, so push-to-talk only works while Shpihcord is focused."
          : pttGlobal
            ? "Works everywhere, even while you're in a game."
            : "Push-to-talk works while Shpihcord is focused."}
      </p>
    </div>
  );
}
