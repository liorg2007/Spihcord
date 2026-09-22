import { hostOf } from "../lib/format";
import { useApp } from "../store/app";
import { LogoMark } from "./Icons";

export function ServerRail() {
  const serverUrl = useApp((s) => s.session?.serverUrl ?? "");
  return (
    <nav className="rail" aria-label="Servers">
      <div className="rail-item active" title={`Shpihcord — ${hostOf(serverUrl)}`}>
        <span className="rail-pill" />
        <div className="rail-icon">
          <LogoMark size={26} />
        </div>
      </div>
      <div className="rail-sep" />
    </nav>
  );
}
