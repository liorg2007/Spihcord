import { useCallback, useEffect, useMemo, useState } from "react";
import { SCREEN_SHARE_PRESETS, type ScreenSharePresetId } from "@shpihcord/call-engine";
import type { ScreenAudioMode, ScreenAudioSupport, ScreenSource } from "../../../shared/ipc";
import { bridge } from "../lib/bridge";
import { formatMbps } from "../lib/format";
import { getScreenAudioSupport, startScreenShare } from "../lib/voice";
import { setApp, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { AppWindowIcon, MonitorIcon, WarningIcon, XIcon } from "./Icons";

type Tab = "screen" | "window";
const REFRESH_MS = 3000;
export const PRESET_ORDER: ScreenSharePresetId[] = ["text", "balanced", "gaming", "source"];

export function presetDetail(id: ScreenSharePresetId): string {
  const p = SCREEN_SHARE_PRESETS[id];
  const res = id === "text" || id === "source" ? "Native res" : `${p.maxHeight}p`;
  return `${res} · ${p.frameRate} fps · ${formatMbps(p.maxBitrate)} per viewer`;
}

/** Discord-style "Go Live" picker: screens / windows with live thumbnails, quality, audio. */
export function GoLiveModal() {
  const [tab, setTab] = useState<Tab>("screen");
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [support, setSupport] = useState<ScreenAudioSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = useSettings((s) => s.screenPreset);
  const audioPref = useSettings((s) => s.screenAudio);
  const appOnly = useSettings((s) => s.screenAppAudioOnly);
  const liveAlready = useApp((s) => s.localShare?.status === "live");
  const friends = useApp((s) => {
    const ch = s.voiceChannelId;
    return ch ? Object.values(s.voiceStates).filter((v) => v.channelId === ch && v.userId !== s.self?.id).length : 0;
  });
  const close = useCallback(() => setApp({ goLiveOpen: false }), []);

  useEffect(() => {
    void getScreenAudioSupport().then(setSupport);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const list = await bridge.screen.getSources();
        if (alive) setSources(list);
      } catch (err) {
        console.warn("[screen] getSources failed", err);
        if (alive) setSources((prev) => prev ?? []);
      }
      if (alive) timer = setTimeout(() => void refresh(), REFRESH_MS);
    };
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  const list = useMemo(() => (sources ?? []).filter((s) => s.kind === tab), [sources, tab]);
  const switchTab = (t: Tab) => {
    setTab(t);
    if (selected && !selected.startsWith(t)) setSelected(null);
  };
  const selectedSource = sources?.find((s) => s.id === selected) ?? null;

  // Pick the first screen by default; drop a selection whose window closed.
  useEffect(() => {
    if (!sources) return;
    if (selected && !sources.some((s) => s.id === selected)) setSelected(null);
    else if (!selected && tab === "screen") {
      const first = sources.find((s) => s.kind === "screen");
      if (first) setSelected(first.id);
    }
  }, [sources, selected, tab]);

  const audioSupported = !!support?.system;
  // Default: on where our own audio is kept out of the stream, off otherwise.
  const audioOn = audioSupported && (audioPref ?? !!support?.excludesOwnAudio);
  const appAudioAvailable = !!support?.appAudio && selectedSource?.kind === "window";
  const p = SCREEN_SHARE_PRESETS[preset];

  const goLive = async (src: ScreenSource | null) => {
    if (!src || busy) return;
    const audio: ScreenAudioMode = !audioOn ? "none" : support?.appAudio && src.kind === "window" && appOnly ? "app" : "system";
    setBusy(true);
    const ok = await startScreenShare({ sourceId: src.id, sourceName: src.name, preset, audio });
    setBusy(false);
    if (ok) close();
  };

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="Screen Share" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal golive">
        <header className="modal-head">
          <h2>Screen Share</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <XIcon size={20} />
          </button>
        </header>

        <div className="golive-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "screen"} className={tab === "screen" ? "selected" : ""} onClick={() => switchTab("screen")}>
            <MonitorIcon size={16} /> Screens
          </button>
          <button role="tab" aria-selected={tab === "window"} className={tab === "window" ? "selected" : ""} onClick={() => switchTab("window")}>
            <AppWindowIcon size={16} /> Applications
          </button>
        </div>

        <div className="golive-sources">
          {sources === null && (
            <div className="golive-empty">
              <span className="spinner small" /> Looking for things to share…
            </div>
          )}
          {sources !== null && list.length === 0 && (
            <div className="golive-empty muted">{tab === "screen" ? "No screens found." : "No application windows found."}</div>
          )}
          {list.map((s) => (
            <button
              key={s.id}
              className={`source-card${selected === s.id ? " selected" : ""}`}
              onClick={() => setSelected(s.id)}
              onDoubleClick={() => {
                setSelected(s.id);
                void goLive(s);
              }}
              title={s.name}
            >
              <div className="source-thumb">
                {s.thumbnail ? <img src={s.thumbnail} alt="" draggable={false} /> : <span className="muted">No preview</span>}
              </div>
              <div className="source-name">
                {s.appIcon && <img className="source-icon" src={s.appIcon} alt="" draggable={false} />}
                <span>{s.name}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="golive-options">
          <div className="field-label">Stream Quality</div>
          <div className="preset-row">
            {PRESET_ORDER.map((id) => (
              <button
                key={id}
                className={`preset-chip${preset === id ? " selected" : ""}`}
                onClick={() => useSettings.getState().update({ screenPreset: id })}
                title={presetDetail(id)}
              >
                <span className="preset-label">{SCREEN_SHARE_PRESETS[id].label}</span>
                <span className="preset-sub">{formatMbps(SCREEN_SHARE_PRESETS[id].maxBitrate)}/viewer</span>
              </button>
            ))}
          </div>
          <div className="settings-hint">
            {presetDetail(preset)}.{" "}
            {friends > 0 && (
              <>
                If all {friends} {friends === 1 ? "friend watches" : "friends watch"}, you'll upload about{" "}
                <strong>{formatMbps(p.maxBitrate * friends)}</strong>.
              </>
            )}
          </div>

          <label className={`toggle-row${audioSupported ? "" : " disabled"}`}>
            <div className="toggle-text">
              <div className="toggle-title">Share audio</div>
              <div className="toggle-desc">
                {!audioSupported
                  ? support?.note ?? "Audio sharing isn't supported on this system."
                  : support?.excludesOwnAudio
                    ? "Streams what you hear. Voice chat and Shpihcord sounds are left out, so friends won't hear themselves."
                    : "Streams everything you hear."}
              </div>
            </div>
            <input
              type="checkbox"
              className="toggle-input"
              disabled={!audioSupported}
              checked={audioOn}
              onChange={(e) => useSettings.getState().update({ screenAudio: e.target.checked })}
            />
            <span className="toggle" aria-hidden="true" />
          </label>
          {audioOn && appAudioAvailable && (
            <label className="toggle-row">
              <div className="toggle-text">
                <div className="toggle-title">Only this application's audio</div>
                <div className="toggle-desc">Share sound from {selectedSource?.name ?? "the selected window"} only, not other apps.</div>
              </div>
              <input
                type="checkbox"
                className="toggle-input"
                checked={appOnly}
                onChange={(e) => useSettings.getState().update({ screenAppAudioOnly: e.target.checked })}
              />
              <span className="toggle" aria-hidden="true" />
            </label>
          )}
          {audioSupported && support?.note && (
            <div className={`golive-note${support.excludesOwnAudio ? "" : " warn"}`}>
              {!support.excludesOwnAudio && <WarningIcon size={16} />}
              <span>{support.note}</span>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn btn-secondary" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!selectedSource || busy} onClick={() => void goLive(selectedSource)}>
            {busy ? "Starting…" : liveAlready ? "Switch Stream" : "Go Live"}
          </button>
        </footer>
      </div>
    </div>
  );
}
