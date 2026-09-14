import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Page =
  | "overview"
  | "live"
  | "sensors"
  | "batteries"
  | "radio"
  | "preflight"
  | "replay"
  | "events"
  | "settings";

type Mode = "DEMO" | "LIVE" | "REPLAY";

type Telemetry = {
  time: string;
  pitch: number;
  roll: number;
  gyro: number;
  voltage: number | null;
  battery: number | null;
  signal: number | null;
  temperature: number | null;
};

const nav: Array<{ id: Page; label: string; icon: string; section: string }> = [
  { id: "overview", label: "Overview", icon: "⌂", section: "OPERATIONS" },
  { id: "live", label: "Live monitor", icon: "◉", section: "OPERATIONS" },
  { id: "sensors", label: "Sensors", icon: "⌁", section: "AIRCRAFT" },
  { id: "batteries", label: "Batteries", icon: "▣", section: "AIRCRAFT" },
  { id: "radio", label: "Radio & links", icon: "⌁", section: "AIRCRAFT" },
  { id: "preflight", label: "Preflight", icon: "✓", section: "FLIGHT" },
  { id: "replay", label: "Replay", icon: "↺", section: "FLIGHT" },
  { id: "events", label: "Event history", icon: "≡", section: "RECORDS" },
  { id: "settings", label: "Settings", icon: "⚙", section: "SYSTEM" },
];

const initialTelemetry: Telemetry = {
  time: "—",
  pitch: 0,
  roll: 0,
  gyro: 0,
  voltage: null,
  battery: null,
  signal: null,
  temperature: null,
};

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [mode, setMode] = useState<Mode>("DEMO");
  const [telemetry, setTelemetry] = useState<Telemetry>(initialTelemetry);
  const [history, setHistory] = useState<number[]>([42, 45, 43, 49, 47, 53, 51, 56, 54, 59, 57, 61]);
  const [toast, setToast] = useState("DEMO simulator active");
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (mode !== "DEMO") {
      setTelemetry(initialTelemetry);
      setToast(mode === "LIVE" ? "LIVE is read-only — awaiting verified telemetry" : "REPLAY has no live control path");
      return;
    }

    const tick = () => {
      const now = new Date();
      const t = now.getTime() / 1000;
      const next: Telemetry = {
        time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        pitch: Math.sin(t / 4) * 2.8,
        roll: Math.cos(t / 5) * 5.4,
        gyro: 0.8 + Math.abs(Math.sin(t / 3)) * 1.7,
        voltage: 16.42 - (t % 600) / 6000,
        battery: 92 - (t % 500) / 50,
        signal: 86 + Math.sin(t / 7) * 8,
        temperature: 28.4 + Math.sin(t / 9) * 1.1,
      };
      setTelemetry(next);
      setHistory((items) => [...items.slice(-17), Math.round(next.signal ?? 0)]);
      setToast("DEMO simulator active");
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [mode]);

  const groupedNav = useMemo(() => {
    return nav.reduce<Record<string, typeof nav>>((groups, item) => {
      (groups[item.section] ||= []).push(item);
      return groups;
    }, {});
  }, []);

  const checklistItems = [
    ["airframe", "Airframe secured and propeller removed"],
    ["power", "Power rails and battery divider verified"],
    ["radio", "Transmitter and receiver link verified"],
    ["imu", "MPU6050 detected at a verified address"],
    ["failsafe", "Local receiver failsafe tested"],
    ["authorization", "Local flight authorization confirmed"],
  ];

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast("DEMO simulator active"), 2800);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">FD</div>
          <div>
            <div className="brand-name">FLIGHT DECK</div>
            <div className="brand-subtitle">AIRCRAFT OPERATIONS</div>
          </div>
        </div>

        <div className="aircraft-selector">
          <div className="eyebrow">ACTIVE AIRCRAFT</div>
          <div className="aircraft-row">
            <span className="status-dot green" />
            <strong>FD-001</strong>
            <span className="chevron">⌄</span>
          </div>
          <span className="muted-small">Bench profile · fixed-wing</span>
        </div>

        <nav className="nav">
          {Object.entries(groupedNav).map(([section, items]) => (
            <div className="nav-group" key={section}>
              <div className="nav-section">{section}</div>
              {items.map((item) => (
                <button
                  className={page === item.id ? "nav-item active" : "nav-item"}
                  key={item.id}
                  onClick={() => setPage(item.id)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.id === "live" && <span className="live-pill">DEMO</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="safety-note">
            <span className="shield">◇</span>
            <div>
              <strong>CONTROL LOCKED</strong>
              <span>Browser actuator path disabled</span>
            </div>
          </div>
          <div className="user-chip">
            <div className="avatar">ET</div>
            <div>
              <strong>Operator</strong>
              <span>Local session</span>
            </div>
            <span className="more">•••</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="breadcrumb">FLIGHT DECK <span>/</span> {page.replace("-", " ")}</div>
            <h1>{pageTitle(page)}</h1>
          </div>
          <div className="topbar-actions">
            <div className="connection-badge">
              <span className="status-dot green" />
              Simulator linked
            </div>
            <div className="mode-switcher" aria-label="Operating mode">
              {(["DEMO", "LIVE", "REPLAY"] as Mode[]).map((item) => (
                <button
                  key={item}
                  className={mode === item ? "mode-button selected" : "mode-button"}
                  onClick={() => setMode(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <button className="icon-button" onClick={() => showToast("No new alerts")} aria-label="Notifications">♢</button>
            <div className="top-avatar">ET</div>
          </div>
        </header>

        <div className="content">
          {page === "overview" && <Overview telemetry={telemetry} history={history} onNavigate={setPage} onAction={showToast} />}
          {page === "live" && <LiveMonitor telemetry={telemetry} mode={mode} onAction={showToast} />}
          {page === "sensors" && <Sensors telemetry={telemetry} />}
          {page === "batteries" && <Batteries telemetry={telemetry} />}
          {page === "radio" && <Radio mode={mode} telemetry={telemetry} />}
          {page === "preflight" && (
            <Preflight
              items={checklistItems}
              values={checklist}
              onToggle={(key) => setChecklist((current) => ({ ...current, [key]: !current[key] }))}
              onAction={showToast}
            />
          )}
          {page === "replay" && <Replay onAction={showToast} />}
          {page === "events" && <Events />}
          {page === "settings" && <Settings onAction={showToast} />}
        </div>

        <div className="toast">{toast}</div>
      </main>
    </div>
  );
}

function pageTitle(page: Page) {
  return {
    overview: "Mission overview",
    live: "Live flight monitor",
    sensors: "Sensors & calibration",
    batteries: "Battery systems",
    radio: "Radio & connectivity",
    preflight: "Preflight checklist",
    replay: "Sessions & replay",
    events: "Event history",
    settings: "Profiles & settings",
  }[page];
}

function Overview({ telemetry, history, onNavigate, onAction }: { telemetry: Telemetry; history: number[]; onNavigate: (page: Page) => void; onAction: (text: string) => void }) {
  return (
    <>
      <div className="hero-strip">
        <div>
          <div className="eyebrow lime">FLIGHT READINESS</div>
          <h2>Bench simulation ready</h2>
          <p>Telemetry is simulated locally. Real aircraft authorization remains onboard.</p>
        </div>
        <div className="hero-actions">
          <button className="button primary" onClick={() => onNavigate("preflight")}>Open preflight <span>→</span></button>
          <button className="button ghost" onClick={() => onAction("Flight controls remain locked in the browser")}>Control boundary <span>◇</span></button>
        </div>
      </div>

      <div className="metric-grid">
        <Metric label="AIRCRAFT STATUS" value="STANDBY" sub="FD-001 · local bench" tone="lime" icon="✦" />
        <Metric label="TELEMETRY" value={telemetry.time === "—" ? "UNKNOWN" : "LIVE DEMO"} sub={telemetry.time === "—" ? "No verified source" : telemetry.time} tone="orange" icon="⌁" />
        <Metric label="FLIGHT MODE" value="MANUAL" sub="Surface presets only" tone="blue" icon="◒" />
        <Metric label="CONTROL PATH" value="LOCKED" sub="No browser actuator transport" tone="red" icon="◇" />
      </div>

      <div className="dashboard-grid">
        <Panel title="Telemetry health" eyebrow="LAST 60 SECONDS" action="View monitor" onAction={() => onNavigate("live")}>
          <div className="chart-wrap">
            <div className="chart-value">{telemetry.signal == null ? "—" : Math.round(telemetry.signal)}<span>%</span></div>
            <div className="chart-label">LINK QUALITY</div>
            <Sparkline values={history} />
            <div className="chart-axis"><span>60s ago</span><span>30s</span><span>now</span></div>
          </div>
          <div className="health-row">
            <HealthItem label="Radio link" value={telemetry.signal == null ? "Unknown" : "Nominal"} tone="lime" />
            <HealthItem label="IMU stream" value={telemetry.time === "—" ? "Unknown" : "Nominal"} tone="lime" />
            <HealthItem label="Battery" value={telemetry.battery == null ? "Unknown" : "Nominal"} tone="lime" />
          </div>
        </Panel>

        <Panel title="Aircraft profile" eyebrow="FD-001 · FIXED-WING">
          <div className="aircraft-card">
            <div className="aircraft-visual"><div className="aircraft-line" /><div className="aircraft-body" /><div className="aircraft-wing left" /><div className="aircraft-wing right" /><div className="aircraft-tail" /></div>
            <div className="aircraft-details">
              <div><span>PROFILE</span><strong>Bench / fixed-wing</strong></div>
              <div><span>RADIO</span><strong>nRF24L01+ · 2.4 GHz</strong></div>
              <div><span>COMPUTE</span><strong>Nano + NodeMCU</strong></div>
            </div>
          </div>
          <button className="text-button" onClick={() => onNavigate("settings")}>Configure profile <span>→</span></button>
        </Panel>
      </div>

      <div className="section-heading">
        <div><div className="eyebrow">CURRENT STATE</div><h3>Operating snapshot</h3></div>
        <span className="updated">Updated {telemetry.time}</span>
      </div>
      <div className="snapshot-grid">
        <Snapshot title="ATTITUDE" value={telemetry.pitch === 0 && telemetry.roll === 0 ? "0.0°" : `${telemetry.pitch.toFixed(1)}°`} detail={`Pitch · Roll ${telemetry.roll.toFixed(1)}°`} icon="◒" />
        <Snapshot title="AIRCRAFT VOLTAGE" value={telemetry.voltage == null ? "Unknown" : `${telemetry.voltage.toFixed(2)} V`} detail="Divider verification required" icon="▣" />
        <Snapshot title="IMU TEMPERATURE" value={telemetry.temperature == null ? "Unknown" : `${telemetry.temperature.toFixed(1)} °C`} detail="MPU6050 chip temperature" icon="♨" />
        <Snapshot title="LAST EVENT" value="System ready" detail="No active warnings" icon="✓" />
      </div>
    </>
  );
}

function LiveMonitor({ telemetry, mode, onAction }: { telemetry: Telemetry; mode: Mode; onAction: (text: string) => void }) {
  return (
    <>
      <div className="page-alert">
        <span className="alert-icon">◇</span>
        <div><strong>{mode === "LIVE" ? "LIVE telemetry is not verified" : mode === "REPLAY" ? "Replay is isolated from hardware" : "DEMO telemetry is simulated"}</strong><span>{mode === "LIVE" ? "Connect an authenticated device stream before relying on values." : "This page cannot send, queue, or replay actuator commands."}</span></div>
      </div>
      <div className="live-layout">
        <Panel title="Attitude reference" eyebrow="MPU6050 · COMPLEMENTARY FILTER">
          <div className="attitude-display">
            <div className="horizon"><div className="horizon-sky" /><div className="horizon-ground" /><div className="horizon-line" style={{ transform: `rotate(${telemetry.roll}deg) translateY(${telemetry.pitch * 4}px)` }} /><div className="aircraft-symbol">—╋—</div></div>
            <div className="attitude-values"><ValueBlock label="PITCH" value={telemetry.time === "—" ? "Unknown" : `${telemetry.pitch.toFixed(1)}°`} /><ValueBlock label="ROLL" value={telemetry.time === "—" ? "Unknown" : `${telemetry.roll.toFixed(1)}°`} /><ValueBlock label="YAW" value="Not available" /></div>
          </div>
        </Panel>
        <Panel title="Flight instruments" eyebrow="CURRENT SAMPLE">
          <div className="instrument-list">
            <Instrument label="Gyroscope" value={telemetry.gyro == null ? "Unknown" : `${telemetry.gyro.toFixed(2)} °/s`} state="NOMINAL" />
            <Instrument label="Temperature" value={telemetry.temperature == null ? "Unknown" : `${telemetry.temperature.toFixed(1)} °C`} state="NOMINAL" />
            <Instrument label="Battery" value={telemetry.battery == null ? "Unknown" : `${telemetry.battery.toFixed(0)} %`} state="NOMINAL" />
            <Instrument label="Freshness" value={telemetry.time === "—" ? "Unknown" : "1.0 s"} state={telemetry.time === "—" ? "UNKNOWN" : "FRESH"} />
          </div>
          <button className="button locked" onClick={() => onAction("Rejected: browser live command transport is disabled")}>◇ Commands locked</button>
        </Panel>
      </div>
    </>
  );
}

function Sensors({ telemetry }: { telemetry: Telemetry }) {
  const rows = [
    ["MPU6050", telemetry.time === "—" ? "Unknown" : "Detected", telemetry.time === "—" ? "No sample" : "0x68 · I²C"],
    ["Accelerometer", telemetry.time === "—" ? "Unknown" : "Streaming", telemetry.time === "—" ? "—" : "X/Y/Z m/s²"],
    ["Gyroscope", telemetry.time === "—" ? "Unknown" : "Streaming", telemetry.time === "—" ? "—" : "X/Y/Z deg/s"],
    ["Barometer", "Not installed", "No BMP280 source"],
    ["GPS", "Not installed", "No position source"],
    ["Battery divider", "Not verified", "Values remain advisory"],
  ];
  return <><PageIntro eyebrow="AIRCRAFT DATA" title="Sensors & calibration" text="Only measurements with a verified source are shown as measurements. Missing hardware is deliberately visible." /><Panel title="Sensor inventory" eyebrow="FD-001"><div className="table">{rows.map(([name, state, detail]) => <div className="table-row" key={name}><strong>{name}</strong><span className={state === "Streaming" || state === "Detected" ? "tag green-tag" : "tag gray-tag"}>{state}</span><span className="table-detail">{detail}</span><button className="small-link">Inspect</button></div>)}</div></Panel></>;
}

function Batteries({ telemetry }: { telemetry: Telemetry }) {
  return <><PageIntro eyebrow="POWER SYSTEMS" title="Battery systems" text="Battery status stays Unknown until the physical divider, ground, calibration, and full-scale behavior are verified." /><div className="battery-layout"><Panel title="Aircraft battery" eyebrow="A0 · NODEMCU"><div className="battery-visual"><div className="battery-percent">{telemetry.battery == null ? "Unknown" : `${telemetry.battery.toFixed(0)}%`}</div><div className="battery-bar"><div style={{ width: `${telemetry.battery ?? 0}%` }} /></div><div className="battery-meta"><span>Voltage</span><strong>{telemetry.voltage == null ? "Unknown" : `${telemetry.voltage.toFixed(2)} V`}</strong></div><div className="battery-meta"><span>Calibration</span><strong className="orange-text">Not verified</strong></div></div></Panel><Panel title="Safety notes" eyebrow="REQUIRED BEFORE FLIGHT"><div className="note-list"><div>• Never connect battery voltage directly to A0.</div><div>• A saturated ADC reading invalidates the sample.</div><div>• Use a physically measured divider ratio.</div><div>• Do not treat browser values as a flight interlock.</div></div></Panel></div></>;
}

function Radio({ mode, telemetry }: { mode: Mode; telemetry: Telemetry }) {
  return <><PageIntro eyebrow="LINK HEALTH" title="Radio & connectivity" text="The aircraft control link remains local. Cloud connectivity is for monitoring and cannot become a timing dependency for control." /><div className="metric-grid"><Metric label="CONTROL RADIO" value="nRF24L01+" sub="Local receiver path" tone="lime" icon="⌁" /><Metric label="LINK QUALITY" value={telemetry.signal == null ? "Unknown" : `${telemetry.signal.toFixed(0)}%`} sub="Simulator value" tone="blue" icon="◉" /><Metric label="CLOUD PATH" value={mode === "DEMO" ? "SIMULATED" : "NOT CONNECTED"} sub="No retained commands" tone="orange" icon="↗" /></div><Panel title="Connectivity layers" eyebrow="SEPARATE RESPONSIBILITIES"><div className="link-layers"><LinkLayer name="Transmitter → receiver" value="Local control link" state="Independent of dashboard" /><LinkLayer name="Receiver → NodeMCU" value="UART 38400 8N1" state="Monitoring bridge" /><LinkLayer name="NodeMCU → cloud" value="Optional HTTPS telemetry" state="Not a control path" /></div></Panel></>;
}

function Preflight({ items, values, onToggle, onAction }: { items: string[][]; values: Record<string, boolean>; onToggle: (key: string) => void; onAction: (text: string) => void }) {
  const complete = items.filter(([key]) => values[key]).length;
  return <><PageIntro eyebrow="FLIGHT SAFETY" title="Preflight checklist" text="This checklist supports disciplined preparation. It does not authorize flight or replace physical testing." /><div className="preflight-layout"><Panel title="Bench gates" eyebrow={`${complete}/${items.length} COMPLETE`}><div className="checklist">{items.map(([key, label]) => <button className={values[key] ? "check-row complete" : "check-row"} key={key} onClick={() => onToggle(key)}><span className="check-box">{values[key] ? "✓" : ""}</span><span>{label}</span><span className="check-state">{values[key] ? "DONE" : "OPEN"}</span></button>)}</div><button className="button primary wide" onClick={() => onAction(complete === items.length ? "Checklist complete — local authorization still required" : "Complete every bench gate first")}>Review readiness</button></Panel><Panel title="Control boundary" eyebrow="IMPORTANT"><div className="boundary-card"><div className="boundary-icon">◇</div><strong>Browser control is disabled</strong><p>Flight-critical behavior must be owned by the aircraft receiver, including radio-loss handling, output limits, watchdogs, and disarm behavior.</p></div></Panel></div></>;
}

function Replay({ onAction }: { onAction: (text: string) => void }) {
  return <><PageIntro eyebrow="RECORDED DATA" title="Sessions & replay" text="Replay is isolated from current hardware. It can inspect recorded samples but cannot create live alerts or control outputs." /><Panel title="Recording workspace" eyebrow="NO RECORDINGS YET"><div className="empty-state"><div className="empty-icon">↺</div><h3>Ready for a session</h3><p>Start a DEMO recording after telemetry contracts are connected. Recordings will retain their source and freshness metadata.</p><button className="button ghost" onClick={() => onAction("Recording start is available after a telemetry source is selected")}>Select source</button></div></Panel></>;
}

function Events() {
  const events = [["10:42:08", "System initialized", "DEMO simulator started", "lime"], ["10:41:55", "Control path locked", "No browser actuator dispatcher", "orange"], ["10:41:51", "Aircraft selected", "FD-001 · bench profile", "blue"], ["10:41:49", "Session opened", "Local operator session", "gray"]];
  return <><PageIntro eyebrow="AUDIT TRAIL" title="Event history" text="Events describe what the station knows. They are not proof that an actuator moved or that an aircraft is flight-ready." /><Panel title="Recent events" eyebrow="LOCAL SESSION"><div className="event-list">{events.map(([time, title, detail, tone]) => <div className="event-row" key={time + title}><span className={`event-dot ${tone}`} /><span className="event-time">{time}</span><div><strong>{title}</strong><span>{detail}</span></div></div>)}</div></Panel></>;
}

function Settings({ onAction }: { onAction: (text: string) => void }) {
  return <><PageIntro eyebrow="WORKSPACE" title="Profiles & settings" text="Configure display preferences and future connection details without placing secrets in the browser bundle." /><div className="settings-grid"><Panel title="Workspace" eyebrow="LOCAL PROFILE"><Setting label="Aircraft identifier" value="FD-001" /><Setting label="Profile" value="Fixed-wing bench" /><Setting label="Theme" value="Charcoal / lime" /></Panel><Panel title="Cloud connection" eyebrow="OPTIONAL"><Setting label="Supabase URL" value={import.meta.env.VITE_SUPABASE_URL ? "Configured" : "Not configured"} /><Setting label="Authentication" value="Not configured" /><button className="button ghost" onClick={() => onAction("Add public Supabase URL and publishable key through deployment variables")}>Connection guide</button></Panel></div></>;
}

function PageIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <div className="page-intro"><div className="eyebrow lime">{eyebrow}</div><h2>{title}</h2><p>{text}</p></div>;
}

function Panel({ title, eyebrow, action, onAction, children }: { title: string; eyebrow?: string; action?: string; onAction?: () => void; children: React.ReactNode }) {
  return <section className="panel"><div className="panel-header"><div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div>{action && <button className="small-link" onClick={onAction}>{action} →</button>}</div>{children}</section>;
}

function Metric({ label, value, sub, tone, icon }: { label: string; value: string; sub: string; tone: string; icon: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-sub">{sub}</div></div></div>;
}

function Snapshot({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: string }) {
  return <div className="snapshot-card"><span className="snapshot-icon">{icon}</span><div className="snapshot-title">{title}</div><strong>{value}</strong><span>{detail}</span></div>;
}

function HealthItem({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className="health-item"><span className={`status-dot ${tone}`} /><span>{label}</span><strong>{value}</strong></div>;
}

function Sparkline({ values }: { values: number[] }) {
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${70 - ((value - 35) / 70) * 58}`).join(" ");
  return <svg className="sparkline" viewBox="0 0 100 70" preserveAspectRatio="none"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#c6f36b" stopOpacity=".32" /><stop offset="100%" stopColor="#c6f36b" stopOpacity="0" /></linearGradient></defs><polygon points={`0,70 ${points} 100,70`} fill="url(#chart-fill)" /><polyline points={points} fill="none" stroke="#c6f36b" strokeWidth="1.7" /></svg>;
}

function ValueBlock({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Instrument({ label, value, state }: { label: string; value: string; state: string }) {
  return <div className="instrument-row"><span>{label}</span><strong>{value}</strong><small>{state}</small></div>;
}

function LinkLayer({ name, value, state }: { name: string; value: string; state: string }) {
  return <div className="link-layer"><span className="status-dot green" /><div><strong>{name}</strong><span>{value}</span></div><small>{state}</small></div>;
}

function Setting({ label, value }: { label: string; value: string }) {
  return <div className="setting-row"><span>{label}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
