import { useEffect, useMemo, useState, type ClipboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { cloudRequest, sendMagicLink, supabase, supabaseConfigured, verifyEmailCode } from "./lib/supabase";

type Page = "overview" | "monitor" | "mixer" | "modes" | "sensors" | "power" | "radio" | "preflight" | "replay" | "settings";
type Mode = "DEMO" | "LIVE" | "REPLAY";
type ChartKey = "link" | "acceleration" | "angular";

const assetUrl = (name: string) => `${import.meta.env.BASE_URL}${name}`;

type Telemetry = {
  timestamp: string;
  link: number;
  battery: number;
  voltage: number;
  pitch: number;
  roll: number;
  temperature: number;
  acceleration: number[];
  angular: number[];
};

const nav = [
  { id: "overview" as Page, label: "Overview", icon: "⌂", section: "OPERATIONS" },
  { id: "monitor" as Page, label: "Live flight monitor", icon: "⌁", section: "OPERATIONS", badge: "LIVE" },
  { id: "mixer" as Page, label: "Channels & mixer", icon: "≋", section: "CONTROL" },
  { id: "modes" as Page, label: "Flight modes & startup", icon: "✦", section: "CONTROL" },
  { id: "sensors" as Page, label: "Sensors & calibration", icon: "◒", section: "AIRCRAFT" },
  { id: "power" as Page, label: "Batteries", icon: "▣", section: "AIRCRAFT" },
  { id: "radio" as Page, label: "Radio & connectivity", icon: "◉", section: "AIRCRAFT" },
  { id: "replay" as Page, label: "Flight logs & replay", icon: "↺", section: "OPERATIONS" },
  { id: "preflight" as Page, label: "Preflight checklist", icon: "✓", section: "SAFETY", badge: "6" },
  { id: "settings" as Page, label: "Profiles & settings", icon: "⚙", section: "SYSTEM" },
];

const pageTitles: Record<Page, string> = {
  overview: "Mission overview",
  monitor: "Live flight monitor",
  mixer: "Channels & mixer",
  modes: "Flight modes & startup",
  sensors: "Sensors & calibration",
  power: "Batteries",
  radio: "Radio & connectivity",
  preflight: "Preflight checklist",
  replay: "Flight logs & replay",
  settings: "Profiles & settings",
};

type LiveStatus = "demo" | "replay" | "not-configured" | "signed-out" | "awaiting-device" | "connected" | "stale" | "error";

function mapCloudFrame(frame: any): Telemetry {
  const radio = frame?.radio;
  const link = radio?.expected > 0 ? (radio.received / radio.expected) * 100 : frame?.links?.radio === true ? 100 : 0;
  const value = (candidate: unknown, fallback = 0) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  return {
    timestamp: frame?.receivedAt ? new Date(frame.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—",
    link: Math.max(0, Math.min(100, link)),
    battery: 0,
    voltage: value(frame?.aircraftVoltage),
    pitch: value(frame?.attitude?.pitch),
    roll: value(frame?.attitude?.roll),
    temperature: value(frame?.chipTemp),
    acceleration: [value(frame?.accel?.x) / 9.80665, value(frame?.accel?.y) / 9.80665, value(frame?.accel?.z) / 9.80665],
    angular: [value(frame?.gyro?.x), value(frame?.gyro?.y), value(frame?.gyro?.z)],
  };
}

function liveStatusLabel(status: LiveStatus): string {
  return {
    demo: "Simulator linked",
    replay: "Replay isolated",
    "not-configured": "Supabase not configured",
    "signed-out": "Sign-in required",
    "awaiting-device": "Waiting for aircraft",
    connected: "Cloud telemetry linked",
    stale: "Telemetry stale",
    error: "Cloud connection error",
  }[status];
}

const initialTelemetry: Telemetry = {
  timestamp: "—",
  link: 0,
  battery: 0,
  voltage: 0,
  pitch: 0,
  roll: 0,
  temperature: 0,
  acceleration: [0.08, 0.14, -0.98],
  angular: [0.52, -0.41, -0.16],
};

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!supabaseConfigured);
  const [demoAccess, setDemoAccess] = useState(false);
  const [mode, setMode] = useState<Mode>("DEMO");
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [signal, setSignal] = useState<number[]>([82, 86, 84, 89, 87, 91, 88, 92, 90, 94, 91, 93, 96, 94, 95, 93, 96, 95]);
  const [chart, setChart] = useState<ChartKey>("link");
  const [mixEnabled, setMixEnabled] = useState(true);
  const [throttle, setThrottle] = useState(64);
  const [mixStrength, setMixStrength] = useState(58);
  const [notifications, setNotifications] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voice, setVoice] = useState(false);
  const [toast, setToast] = useState("DEMO simulator active");
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("demo");
  const [checks, setChecks] = useState<Record<string, boolean>>({
    battery: true,
    controls: true,
    mixing: true,
    sensors: true,
    radio: true,
    authorization: true,
  });

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (active) {
        setAccountEmail(data.user?.email ?? null);
        setAuthReady(true);
      }
    }).catch(() => {
      if (active) setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccountEmail(session?.user?.email ?? null);
      setAuthReady(true);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (mode !== "LIVE") {
      setLiveStatus(mode === "DEMO" ? "demo" : "replay");
      setTelemetry(initialTelemetry);
      setToast(mode === "DEMO" ? "DEMO simulator active" : "REPLAY is isolated from hardware");
      return;
    }

    let active = true;
    const poll = async () => {
      if (!supabaseConfigured || !supabase) {
        setLiveStatus("not-configured");
        setTelemetry(initialTelemetry);
        setToast("LIVE needs the new Supabase project variables");
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!active) return;
      if (!session) {
        setLiveStatus("signed-out");
        setTelemetry(initialTelemetry);
        setToast("Sign in before reading protected aircraft telemetry");
        return;
      }

      try {
        const response = await cloudRequest("/api/telemetry?aircraftId=FD-001");
        const payload = await response.json() as { frame?: any; error?: string };
        if (!active) return;
        if (!response.ok) {
          setLiveStatus("error");
          setToast(payload.error ?? "Cloud telemetry request failed");
          return;
        }
        if (!payload.frame) {
          setLiveStatus("awaiting-device");
          setTelemetry(initialTelemetry);
          setToast("Supabase connected · waiting for NodeMCU telemetry");
          return;
        }

        const next = mapCloudFrame(payload.frame);
        const age = Date.now() - Number(payload.frame.receivedAt ?? 0);
        setTelemetry(next);
        setSignal((items) => [...items.slice(-23), Math.round(next.link)]);
        setLiveStatus(age > 3000 ? "stale" : "connected");
        setToast(age > 3000 ? "Telemetry is stale · aircraft condition is unknown" : "Live telemetry synchronized");
      } catch {
        if (active) {
          setLiveStatus("error");
          setToast("Cloud telemetry unavailable");
        }
      }
    };

    poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [mode, recording]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const groupedNav = useMemo(() => {
    return nav.reduce<Record<string, typeof nav>>((groups, item) => {
      (groups[item.section] ||= []).push(item);
      return groups;
    }, {});
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(mode === "DEMO" ? "DEMO simulator active" : "Station ready"), 3000);
  };

  const toggleCheck = (key: string) => {
    setChecks((current) => ({ ...current, [key]: !current[key] }));
  };

  if (!authReady) return <AuthLoading />;
  if (!accountEmail && !demoAccess) {
    return <AuthScreen
      onDemo={() => { setDemoAccess(true); setToast("DEMO simulator active"); }}
      onSignedIn={(email) => { setAccountEmail(email); setDemoAccess(false); setToast("Signed in successfully"); }}
    />;
  }

  return (
    <div className={"app-shell" + (sidebarCollapsed ? " sidebar-collapsed" : "") + (mobileNavOpen ? " mobile-nav-open" : "")}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><img src={assetUrl("flight-deck-mark.svg")} alt="" /></div>
          <div>
            <div className="brand-name">FLIGHT DECK</div>
            <div className="brand-caption">AEROSPACE OPERATIONS</div>
          </div>
          <button className="collapse-button" aria-label="Collapse navigation" aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? "›" : "‹"}</button>
        </div>

        <div className="aircraft-card-mini">
          <div className="eyebrow">ACTIVE AIRCRAFT</div>
          <div className="aircraft-name-row">
            <span className="aircraft-icon"><img className="aircraft-icon-image" src={assetUrl("flight-deck-mark.svg")} alt="" /></span>
            <div><strong>Falcon 01</strong><span>FD-001 · Fixed-wing</span></div>
            <span className="online-dot" />
          </div>
          <div className="profile-row"><span>Bench profile</span><span className="profile-chip">SIMULATOR</span></div>
        </div>

        <nav className="navigation">
          {Object.entries(groupedNav).map(([section, items]) => (
            <div className="nav-section-group" key={section}>
              <div className="nav-section-label">{section}</div>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={page === item.id ? "nav-link active" : "nav-link"}
                  onClick={() => { setPage(item.id); setMobileNavOpen(false); }}
                  aria-current={page === item.id ? "page" : undefined}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <span className="nav-link-icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.badge && <span className={item.badge === "LIVE" ? "nav-badge live" : "nav-badge"}>{item.badge}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="control-lock">
            <span className="lock-icon">◇</span>
            <div><strong>LOCAL CONTROL FIRST</strong><span>Radio control stays onboard.</span></div>
          </div>
          <div className="system-health">
            <div className="system-health-top"><span className="online-dot" /> Station healthy <span>v0.1</span></div>
            <div className="health-bars"><i /><i /><i /><i /><i /></div>
          </div>
          <div className="operator">
            <div className="operator-avatar">ET</div>
            <div><strong>Ennis Turkson</strong><span>Owner · verified</span></div>
            <span className="operator-more">•••</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" aria-label="Open menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(!mobileNavOpen)}>☰</button>
            <div className="breadcrumb">FLIGHT OPERATIONS <span>/</span> {pageTitles[page]}</div>
            <h1>{pageTitles[page]}</h1>
          </div>
          <div className="topbar-right">
            {accountEmail ? <><div className="verified-pill"><span className="online-dot" /> Verified account · {accountEmail}</div><button className="signout-button" onClick={async () => { await supabase?.auth.signOut(); setAccountEmail(null); setDemoAccess(false); setToast("Signed out"); }}>Sign out</button></> : <button className="verified-pill signin-trigger" onClick={() => setAuthOpen(true)}><span className="status-led orange" /> Sign in</button>}
            <button className="command-trigger" onClick={() => setCommandOpen(true)} aria-label="Open command center"><span>Search</span><kbd>⌘ K</kbd></button>
            <div className="mode-control">
              {(["DEMO", "LIVE", "REPLAY"] as Mode[]).map((item) => (
                <button key={item} className={mode === item ? "mode-tab selected" : "mode-tab"} onClick={() => setMode(item)}>{item}</button>
              ))}
            </div>
            <button className={recording ? "record-button active" : "record-button"} onClick={() => { setRecording(!recording); notify(recording ? "Recording stopped" : "Recording started"); }}>
              <span className={recording ? "record-dot pulse" : "record-dot"} /> {recording ? "Recording" : "Record"}
            </button>
            <button className={notifications ? "top-icon-button selected" : "top-icon-button"} onClick={() => setNotifications(!notifications)} aria-label="Notifications">♢</button>
            <div className="top-avatar">ET</div>
          </div>
        </header>

        {commandOpen && <div className="command-backdrop" onClick={() => setCommandOpen(false)}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command center" onClick={(event) => event.stopPropagation()}>
            <div className="command-search"><span>⌕</span><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search pages and aircraft tools..." /></div>
            <div className="command-label">NAVIGATE</div>
            <div className="command-results">
              {nav.filter((item) => item.label.toLowerCase().includes(commandQuery.toLowerCase())).map((item) => <button key={item.id} onClick={() => { setPage(item.id); setCommandOpen(false); setCommandQuery(""); }}><span className="command-result-icon">{item.icon}</span><strong>{item.label}</strong><small>{item.section}</small><i>↵</i></button>)}
              {nav.filter((item) => item.label.toLowerCase().includes(commandQuery.toLowerCase())).length === 0 && <div className="command-empty">No dashboard destination matches “{commandQuery}”.</div>}
            </div>
            <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> browse</span><span><kbd>esc</kbd> close</span><strong>FLIGHT DECK / COMMAND</strong></div>
          </section>
        </div>}
        {authOpen && <SignInModal accountEmail={accountEmail} onClose={() => setAuthOpen(false)} onSignedIn={(email) => { setAccountEmail(email); setDemoAccess(false); setAuthOpen(false); notify("Signed in successfully"); }} onSignedOut={() => { setAccountEmail(null); notify("Signed out"); }} />}
          <div className="content">
          <div className="context-bar">
            <div className="context-status"><span className={liveStatus === "connected" ? "status-led green" : "status-led orange"} /><strong>{liveStatusLabel(liveStatus)}</strong><span>Falcon 01 · FD-001</span></div>
            <div className="context-actions">
              <button className="outline-button" onClick={() => notify("Control path is locked in the browser")}>◇ Parachute</button>
              <button className="outline-button" onClick={() => setVoice(!voice)}>{voice ? "◉ Voice on" : "◌ Voice off"}</button>
              <button className="outline-button" onClick={() => notify("No new alerts")}>Alerts <span className="alert-count">3</span></button>
            </div>
          </div>

          {notifications && <div className="notification-drawer"><strong>Station notifications</strong><span>All current alerts are simulator-only. No live device telemetry is verified.</span><button onClick={() => setNotifications(false)}>Dismiss</button></div>}

          {page === "overview" && (
            <Overview
              telemetry={telemetry}
              signal={signal}
              chart={chart}
              setChart={setChart}
              mixEnabled={mixEnabled}
              setMixEnabled={setMixEnabled}
              throttle={throttle}
              setThrottle={setThrottle}
              mixStrength={mixStrength}
              setMixStrength={setMixStrength}
              onNavigate={setPage}
              notify={notify}
            />
          )}
          {page === "monitor" && <Monitor telemetry={telemetry} signal={signal} mode={mode} onAction={notify} />}
          {page === "mixer" && <Mixer mixEnabled={mixEnabled} setMixEnabled={setMixEnabled} throttle={throttle} setThrottle={setThrottle} mixStrength={mixStrength} setMixStrength={setMixStrength} onAction={notify} />}
          {page === "modes" && <FlightModes onAction={notify} />}
          {page === "sensors" && <Sensors telemetry={telemetry} onAction={notify} />}
          {page === "power" && <Power telemetry={telemetry} />}
          {page === "radio" && <RadioConnectivity telemetry={telemetry} signal={signal} mode={mode} onAction={notify} />}
          {page === "preflight" && <Preflight checks={checks} toggleCheck={toggleCheck} onAction={notify} />}
          {page === "replay" && <Replay onAction={notify} />}
          {page === "settings" && <Settings onAction={notify} accountEmail={accountEmail} />}

          <footer className="content-footer"><span>FLIGHT DECK / ENGINEERING CONSOLE</span><span><span className="status-led green" /> Local control first · Browser actuator path disabled</span></footer>
        </div>
        <div className="toast">{toast}</div>
      </main>
    </div>
  );
}

function Overview(props: {
  telemetry: Telemetry;
  signal: number[];
  chart: ChartKey;
  setChart: (value: ChartKey) => void;
  mixEnabled: boolean;
  setMixEnabled: (value: boolean) => void;
  throttle: number;
  setThrottle: (value: number) => void;
  mixStrength: number;
  setMixStrength: (value: number) => void;
  onNavigate: (page: Page) => void;
  notify: (message: string) => void;
}) {
  const { telemetry, signal, chart, setChart, mixEnabled, setMixEnabled, throttle, setThrottle, mixStrength, setMixStrength, onNavigate, notify } = props;
  const leftAileron = Math.round(1500 + (mixEnabled ? (mixStrength * 1.5) : 86));
  const rightAileron = Math.round(1500 - (mixEnabled ? (mixStrength * 1.5) : 86));
  return (
    <>
      <section className="mission-hero">
        <div className="hero-copy">
          <div className="eyebrow lime">MISSION CONTROL · DEMO ENVIRONMENT</div>
          <h2>Operational clarity<br /><em>at every altitude.</em></h2>
          <p>Observe the aircraft system, validate control surfaces, and keep flight-critical decisions onboard.</p>
          <div className="hero-buttons"><button className="primary-button" onClick={() => onNavigate("preflight")}>Open preflight <span>→</span></button><button className="ghost-button" onClick={() => notify("Live aircraft control is intentionally locked")}>Review control boundary <span>◇</span></button></div>
        </div>
        <div className="hero-orbit">
          <div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-ring ring-three" />
          <img className="hero-aircraft-image" src={assetUrl("falcon-aircraft.svg")} alt="Falcon 01 fixed-wing digital twin" />
          <div className="orbit-label label-top">FD-001</div><div className="orbit-label label-right">BENCH / 01</div><div className="orbit-label label-bottom">NOMINAL</div>
        </div>
        <div className="hero-readiness"><span>READINESS</span><strong>STANDBY</strong><small>Telemetry simulated</small><div className="readiness-track"><i /></div><button onClick={() => onNavigate("preflight")}>6/6 operator gates →</button></div>
      </section>

      <section className="kpi-grid">
        <Kpi icon="⌁" label="TELEMETRY" value="LIVE DEMO" detail={telemetry.timestamp} accent="lime" trend="+ stable" />
        <Kpi icon="◉" label="LINK QUALITY" value={Math.round(telemetry.link) + "%"} detail="nRF24 status · nominal" accent="blue" trend="+4.2%" />
        <Kpi icon="▣" label="AIRCRAFT BATTERY" value={telemetry.voltage.toFixed(2) + " V"} detail={Math.round(telemetry.battery) + "% estimated"} accent="orange" trend="- 0.2 V" />
        <Kpi icon="◒" label="ATTITUDE" value={telemetry.pitch.toFixed(1) + "°"} detail={"Pitch · Roll " + telemetry.roll.toFixed(1) + "°"} accent="violet" trend="steady" />
        <Kpi icon="◇" label="CONTROL PATH" value="LOCKED" detail="Local receiver owns control" accent="red" trend="protected" />
      </section>

      <section className="dashboard-columns">
        <Panel eyebrow="SYSTEM TELEMETRY · 60 SECOND WINDOW" title="Station signal overview" action="Open monitor →" onAction={() => onNavigate("monitor")} wide>
          <div className="chart-toolbar"><div className="chart-stat"><strong>{chart === "link" ? Math.round(telemetry.link) + "%" : chart === "acceleration" ? telemetry.acceleration[2].toFixed(2) + " g" : telemetry.angular[0].toFixed(2) + "°/s"}</strong><span>{chart === "link" ? "LINK QUALITY" : chart === "acceleration" ? "RAW ACCELERATION · Z" : "ANGULAR VELOCITY · X"}</span></div><div className="chart-tabs">{(["link", "acceleration", "angular"] as ChartKey[]).map((item) => <button className={chart === item ? "chart-tab selected" : "chart-tab"} key={item} onClick={() => setChart(item)}>{item === "link" ? "Link" : item === "acceleration" ? "Acceleration" : "Angular velocity"}</button>)}</div></div>
          <TelemetryChart values={chart === "link" ? signal : chart === "acceleration" ? signal.map((_, i) => 55 + Math.sin(i / 2) * 17) : signal.map((_, i) => 50 + Math.cos(i / 2.4) * 14)} color={chart === "link" ? "lime" : chart === "acceleration" ? "orange" : "blue"} />
          <div className="chart-footer"><span>11:33:17</span><span>11:33:37</span><span>11:33:57</span><span>NOW · {telemetry.timestamp}</span></div>
        </Panel>

        <Panel eyebrow="AIRCRAFT DIGITAL TWIN" title="Falcon 01" action="Configure →" onAction={() => onNavigate("settings")}>
          <div className="aircraft-twin">
            <div className="twin-grid" /><img className="twin-aircraft-image" src={assetUrl("falcon-aircraft.svg")} alt="Falcon 01 aircraft top view" />
            <div className="twin-label top">PITCH {telemetry.pitch.toFixed(1)}°</div><div className="twin-label right">ROLL {telemetry.roll.toFixed(1)}°</div><div className="twin-label bottom">IMU · 0x68</div>
          </div>
          <div className="twin-meta"><div><span>PROFILE</span><strong>Fixed-wing / custom</strong></div><div><span>RADIO</span><strong>nRF24L01+ · 2.4 GHz</strong></div><div><span>COMPUTE</span><strong>Nano + NodeMCU</strong></div></div>
        </Panel>
      </section>

      <div className="section-title-row"><div><div className="eyebrow">CONTROL SYSTEM</div><h3>Channels & mixer</h3></div><button className="text-button" onClick={() => onNavigate("mixer")}>Open full mixer →</button></div>
      <section className="dashboard-columns control-columns">
        <Panel eyebrow="INTERACTIVE SIMULATOR" title="Physical controller inputs">
          <div className="joysticks"><Joystick label="JOYSTICK 1" x="0.03" y="0.09" /><Joystick label="JOYSTICK 2" x="0.23" y="0.58" active /></div>
          <RangeRow label="Throttle slider · A6" value={throttle} setValue={setThrottle} suffix="%" />
          <div className="pot-row"><span>Potentiometer 1 · A4</span><b>42%</b><span>Potentiometer 2 · A5</span><b>68%</b></div>
        </Panel>
        <Panel eyebrow="COMMANDED POSITION" title={mixEnabled ? "Roll mixing · active" : "Independent ailerons"}>
          <div className="aileron-view"><div className="aileron-readout"><span>LEFT AILERON<strong>{leftAileron} <small>µs</small></strong></span><span>RIGHT AILERON<strong>{rightAileron} <small>µs</small></strong></span></div><div className="plane-control"><span className="plane-body" /><span className="plane-wing left" /><span className="plane-wing right" /><span className="plane-tail" /></div></div>
          <div className="mix-rule"><span>L = common + roll</span><span>R = common − roll</span></div>
          <RangeRow label="Mix strength" value={mixStrength} setValue={setMixStrength} suffix="%" />
          <div className="switch-row"><span><i className="status-led green" /> Aileron mixing</span><button className={mixEnabled ? "toggle on" : "toggle"} onClick={() => setMixEnabled(!mixEnabled)}><i /></button><b>{mixEnabled ? "MIX ON" : "MIX OFF"}</b></div>
        </Panel>
      </section>

      <section className="lower-grid">
        <Panel eyebrow="SYSTEM HEALTH" title="Operational status"><HealthRow label="MPU6050 telemetry" value="Nominal" detail="0x68 · 10 Hz target" tone="green" /><HealthRow label="Control radio" value="Nominal" detail="nRF24 · 250 kbps" tone="green" /><HealthRow label="Aircraft battery" value="Advisory" detail="Divider calibration pending" tone="orange" /><HealthRow label="Cloud gateway" value="Not connected" detail="Live source required" tone="gray" /></Panel>
        <Panel eyebrow="EVENT STREAM" title="Recent events" action="View history →" onAction={() => onNavigate("replay")}><EventRow time="11:34:06" title="Simulator sample received" detail="Telemetry synchronized · 600 samples" tone="green" /><EventRow time="11:33:58" title="Mixing confirmed" detail={mixEnabled ? "Aircraft-confirmed mix state is ON" : "Aircraft-confirmed mix state is OFF"} tone="blue" /><EventRow time="11:33:41" title="Control path locked" detail="Browser actuator transport disabled" tone="orange" /></Panel>
      </section>
    </>
  );
}

function Monitor({ telemetry, signal, mode, onAction }: { telemetry: Telemetry; signal: number[]; mode: Mode; onAction: (message: string) => void }) {
  return <><PageIntro eyebrow={"FLIGHT OPERATIONS / " + mode} title="Live flight monitor" text="A high-density view of aircraft attitude, sensor health, link freshness, and system boundaries." /><div className="alert-banner"><span className="warning-symbol">△</span><div><strong>{mode === "LIVE" ? "LIVE telemetry is stale" : mode === "REPLAY" ? "Replay is isolated from hardware" : "DEMO telemetry is simulated"}</strong><span>{mode === "LIVE" ? "No verified device sample has reached the station. Current condition is unknown." : "This station cannot queue, replay, or dispatch actuator commands from the browser."}</span></div></div><section className="dashboard-columns"><Panel eyebrow="ATTITUDE REFERENCE" title="Artificial horizon" wide><div className="monitor-attitude"><div className="horizon-large"><div className="horizon-sky" /><div className="horizon-ground" /><div className="horizon-line" style={{ transform: "rotate(" + telemetry.roll + "deg) translateY(" + telemetry.pitch * 5 + "px)" }} /><div className="horizon-aircraft">—╋—</div></div><div className="attitude-readouts"><Readout label="PITCH" value={mode === "LIVE" ? "Unknown" : telemetry.pitch.toFixed(1) + "°"} /><Readout label="ROLL" value={mode === "LIVE" ? "Unknown" : telemetry.roll.toFixed(1) + "°"} /><Readout label="YAW" value="Not available" /><Readout label="SAMPLE AGE" value={mode === "DEMO" ? "1.0 s" : "Stale"} /></div></div></Panel><Panel eyebrow="CURRENT SAMPLE" title="Flight instruments"><Instrument label="Link quality" value={mode === "LIVE" ? "Unknown" : Math.round(telemetry.link) + "%"} state="NOMINAL" /><Instrument label="Aircraft battery" value={mode === "LIVE" ? "Unknown" : telemetry.voltage.toFixed(2) + " V"} state="ADVISORY" /><Instrument label="IMU temperature" value={mode === "LIVE" ? "Unknown" : telemetry.temperature.toFixed(1) + " °C"} state="NOMINAL" /><Instrument label="Control transport" value="Disabled" state="LOCKED" /><button className="locked-button" onClick={() => onAction("Rejected: browser live command transport is disabled")}>◇ Commands locked</button></Panel></section><Panel eyebrow="LINK QUALITY · SYNCHRONIZED TELEMETRY" title="Signal history"><TelemetryChart values={signal} color="lime" /><div className="chart-footer"><span>60s ago</span><span>30s</span><span>10s</span><span>NOW · {telemetry.timestamp}</span></div></Panel></>;
}

function Mixer({ mixEnabled, setMixEnabled, throttle, setThrottle, mixStrength, setMixStrength, onAction }: { mixEnabled: boolean; setMixEnabled: (v: boolean) => void; throttle: number; setThrottle: (v: number) => void; mixStrength: number; setMixStrength: (v: number) => void; onAction: (message: string) => void }) {
  return <><PageIntro eyebrow="FLIGHT OPERATIONS / DEMO" title="Channels & mixer" text="Trace every input. Understand every output. These are commanded PWM references, not measured servo angles." /><div className="mix-toolbar"><button className="preset-select" onClick={() => onAction("Preset menu opened · Gentle roll & pitch active")}>Gentle roll & pitch <span>⌄</span></button><button className="outline-button" onClick={() => onAction("Configuration saved locally for this session")}>▣ Save changes</button><button className="primary-button" onClick={() => onAction("Session recording started")}>● Record session</button></div><div className="mix-state-banner"><strong>{mixEnabled ? "Roll mixing" : "Independent ailerons"}</strong><span className="mix-confirmed">{mixEnabled ? "MIX ON" : "MIX OFF"}</span><small>Requested v1 / Simulator confirmed {mixEnabled ? "1" : "0"}</small></div><section className="dashboard-columns"><Panel eyebrow="INTERACTIVE SIMULATOR" title="Physical controller inputs" wide><div className="joysticks large"><Joystick label="JOYSTICK 1" x="0.03" y="0.09" /><Joystick label="JOYSTICK 2" x="0.23" y="0.58" active /></div><RangeRow label="Throttle slider · A6" value={throttle} setValue={setThrottle} suffix="%" /><div className="pot-row"><span>Potentiometer 1 · A4</span><b>42%</b><span>Potentiometer 2 · A5</span><b>68%</b></div></Panel><Panel eyebrow="COMMANDED POSITION" title="Aileron mixing"><div className="aileron-large"><div className="aileron-readout"><span>LEFT AILERON<strong>{Math.round(1500 + (mixEnabled ? mixStrength * 1.5 : 86))} <small>µs</small></strong></span><span>RIGHT AILERON<strong>{Math.round(1500 - (mixEnabled ? mixStrength * 1.5 : 86))} <small>µs</small></strong></span></div><div className="plane-control large-plane"><span className="plane-body" /><span className="plane-wing left" /><span className="plane-wing right" /><span className="plane-tail" /></div></div><div className="mix-rule"><span>L = common + roll</span><span>R = common − roll</span></div><RangeRow label="Mix strength" value={mixStrength} setValue={setMixStrength} suffix="%" /><div className="switch-row"><span><i className="status-led green" /> Aileron mixing</span><button className={mixEnabled ? "toggle on" : "toggle"} onClick={() => setMixEnabled(!mixEnabled)}><i /></button><b>{mixEnabled ? "MIX ON" : "MIX OFF"}</b></div></Panel></section><div className="channel-table"><div className="table-header"><span>CHANNEL</span><span>FUNCTION</span><span>INPUT</span><span>COMMAND</span><span>STATE</span></div><ChannelRow number="CH1" name="Elevator" input="Joystick 1 Y" command="1509 µs" /><ChannelRow number="CH2" name="Rudder" input="Joystick 1 X" command="1497 µs" /><ChannelRow number="CH3" name="Left aileron" input="Joystick 2 X" command="1586 µs" /><ChannelRow number="CH4" name="Right aileron" input="Joystick 2 Y" command="1414 µs" /><ChannelRow number="CH5" name="Throttle" input="Slider · A6" command={throttle + "%"} /><ChannelRow number="CH8" name="Parachute" input="Guarded event" command="LOCKED" warning /></div></>;
}


function FlightModes({ onAction }: { onAction: (message: string) => void }) {
  const [selected, setSelected] = useState("Cruise");
  const [expo, setExpo] = useState(32);
  const [rate, setRate] = useState(72);
  const [transition, setTransition] = useState(18);
  const [startupGuard, setStartupGuard] = useState(true);
  const presets = [
    { name: "Launch", icon: "↗", copy: "Positive pitch authority with a conservative throttle ramp.", throttle: "55% cap", mix: "50% mix", tone: "lime" },
    { name: "Cruise", icon: "—", copy: "Balanced response for stable, efficient fixed-wing flight.", throttle: "78% cap", mix: "58% mix", tone: "blue" },
    { name: "Landing", icon: "↘", copy: "Soft rates and additional expo for the approach corridor.", throttle: "42% cap", mix: "38% mix", tone: "orange" },
  ];
  return <><PageIntro eyebrow="CONTROL PROFILE / LOCAL STAGING" title="Flight modes & startup" text="Shape the operator profile and validate the startup sequence. Changes remain in the browser until deliberately exported to supported firmware." />
    <div className="mode-card-grid">{presets.map((preset) => <button key={preset.name} className={selected === preset.name ? "flight-mode-card selected" : "flight-mode-card"} onClick={() => { setSelected(preset.name); onAction(preset.name + " profile selected"); }}><span className={"flight-mode-icon " + preset.tone}>{preset.icon}</span><div><small>FLIGHT PROFILE</small><h3>{preset.name}</h3><p>{preset.copy}</p><footer><span>{preset.throttle}</span><span>{preset.mix}</span></footer></div><i>{selected === preset.name ? "ACTIVE" : "SELECT"}</i></button>)}</div>
    <section className="dashboard-columns mode-workspace"><Panel eyebrow="RESPONSE SHAPING" title={selected + " control envelope"} wide><div className="envelope-visual"><div className="envelope-axis horizontal" /><div className="envelope-axis vertical" /><svg viewBox="0 0 100 54" preserveAspectRatio="none" aria-hidden="true"><path d="M0 50 C20 49, 25 38, 43 29 S70 15, 100 3" /><path className="envelope-shadow" d="M0 50 C20 49, 25 38, 43 29 S70 15, 100 3" /></svg><span className="envelope-label start">SOFT CENTER</span><span className="envelope-label end">FULL AUTHORITY</span></div><RangeRow label="Stick expo" value={expo} setValue={setExpo} suffix="%" /><RangeRow label="Maximum control rate" value={rate} setValue={setRate} suffix="%" /><RangeRow label="Mode transition time" value={transition} setValue={setTransition} suffix=" ds" /></Panel>
    <Panel eyebrow="POWER-ON DISCIPLINE" title="Startup sequence"><div className="startup-sequence"><SequenceStep number="01" title="Throttle at minimum" detail="Physical slider validated at the transmitter." state="REQUIRED" /><SequenceStep number="02" title="Receiver establishes radio" detail="nRF24 handshake before surface output." state="ONBOARD" /><SequenceStep number="03" title="Neutral surface hold" detail="Servo outputs remain at configured failsafe." state="ONBOARD" /><SequenceStep number="04" title="Operator authorization" detail="Physical pilot retains final authority." state="LOCAL" /></div><div className="setting-toggle-row compact"><span>Require startup guard in exported profile</span><button className={startupGuard ? "toggle on" : "toggle"} onClick={() => setStartupGuard(!startupGuard)} aria-pressed={startupGuard}><i /></button></div><button className="primary-button wide" onClick={() => onAction(selected + " profile staged locally — no aircraft command sent")}>Stage {selected.toLowerCase()} profile</button></Panel></section>
    <div className="boundary-card"><span className="boundary-icon">◇</span><div><strong>Flight modes do not move control surfaces from the web</strong><p>The dashboard edits a reviewable profile. The Nano receiver must validate and apply supported configuration while the physical transmitter remains authoritative.</p></div><span className="boundary-status">CONTROL PATH LOCKED</span></div>
  </>;
}

function RadioConnectivity({ telemetry, signal, mode, onAction }: { telemetry: Telemetry; signal: number[]; mode: Mode; onAction: (message: string) => void }) {
  const [radioChannel, setRadioChannel] = useState(76);
  const [dataRate, setDataRate] = useState("250 kbps");
  const average = Math.round(signal.reduce((sum, value) => sum + value, 0) / Math.max(signal.length, 1));
  const shownLink = mode === "LIVE" && telemetry.timestamp === "—" ? 0 : Math.round(telemetry.link || average);
  return <><PageIntro eyebrow="LINK LAYER / DIAGNOSTICS" title="Radio & connectivity" text="One traceable view from the physical transmitter to the cloud gateway. Radio control remains independent of Wi-Fi and Supabase." />
    <div className="radio-kpis"><Kpi icon="◉" label="NRF24 LINK" value={shownLink + "%"} detail={"Channel " + radioChannel + " · " + dataRate} accent="lime" trend={mode} /><Kpi icon="↯" label="PACKET AGE" value={mode === "LIVE" ? "UNKNOWN" : "18 ms"} detail="Receiver sample freshness" accent="blue" trend="< 100 ms" /><Kpi icon="⌁" label="WIFI UPLINK" value={mode === "LIVE" ? "WAITING" : "-61 dBm"} detail="NodeMCU telemetry path" accent="orange" trend="Advisory" /><Kpi icon="☁" label="CLOUD SESSION" value={mode === "LIVE" ? "PROTECTED" : "SIMULATED"} detail="Supabase authenticated" accent="violet" trend="Read-only" /></div>
    <Panel eyebrow="SYSTEM ARCHITECTURE" title="End-to-end signal path"><div className="radio-topology"><TopologyNode icon="◎" title="Handset" detail="Nano TX" status="LOCAL INPUT" /><span className="topology-link active"><i /><small>nRF24</small></span><TopologyNode icon="◉" title="Aircraft radio" detail="Nano RX" status="CONTROL OWNER" /><span className="topology-link"><i /><small>UART</small></span><TopologyNode icon="⌁" title="Gateway" detail="NodeMCU" status="TELEMETRY" /><span className="topology-link cloud"><i /><small>HTTPS</small></span><TopologyNode icon="☁" title="Flight Deck" detail="Supabase" status="OBSERVE" /></div><div className="topology-legend"><span><i className="status-led green" /> Flight-critical radio path</span><span><i className="status-led blue" /> Non-critical telemetry path</span><strong>Internet loss cannot remove local radio control.</strong></div></Panel>
    <section className="dashboard-columns radio-workspace"><Panel eyebrow="PACKET DELIVERY / 60 SECOND WINDOW" title="Link-quality history" wide><div className="chart-toolbar"><div className="chart-stat"><strong>{shownLink}%</strong><span>AVERAGE DELIVERY · {average}%</span></div><span className="radio-live-chip"><i className="status-led green" /> {mode} SOURCE</span></div><TelemetryChart values={signal} color="lime" /><div className="chart-footer"><span>60 seconds ago</span><span>Target ≥ 90%</span><span>Warning &lt; 70%</span><span>NOW</span></div></Panel>
    <Panel eyebrow="BENCH CONFIGURATION" title="Radio profile"><div className="radio-setting"><span>RF channel</span><div className="segmented-control">{[40, 76, 108].map((channel) => <button key={channel} className={radioChannel === channel ? "selected" : ""} onClick={() => { setRadioChannel(channel); onAction("RF channel " + channel + " staged locally"); }}>{channel}</button>)}</div></div><div className="radio-setting"><span>Air data rate</span><div className="segmented-control">{["250 kbps", "1 Mbps", "2 Mbps"].map((rate) => <button key={rate} className={dataRate === rate ? "selected" : ""} onClick={() => { setDataRate(rate); onAction(rate + " staged locally"); }}>{rate}</button>)}</div></div><HealthRow label="Auto acknowledgment" value="Enabled" detail="5 retry attempts · staged profile" tone="green" /><HealthRow label="Receiver failsafe" value="Onboard" detail="Browser cannot override it" tone="blue" /><button className="outline-button wide" onClick={() => onAction("Diagnostics snapshot copied to the event log")}>Capture diagnostics snapshot</button></Panel></section>
  </>;
}

function SequenceStep({ number, title, detail, state }: { number: string; title: string; detail: string; state: string }) {
  return <div className="sequence-step"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><b>{state}</b></div>;
}

function TopologyNode({ icon, title, detail, status }: { icon: string; title: string; detail: string; status: string }) {
  return <div className="topology-node"><span>{icon}</span><strong>{title}</strong><small>{detail}</small><i>{status}</i></div>;
}

function Sensors({ telemetry, onAction }: { telemetry: Telemetry; onAction: (message: string) => void }) {
  return <><PageIntro eyebrow="AIRCRAFT DATA" title="Sensors & calibration" text="Know what is measured, what is inferred, and what remains unknown. Calibration requires a stationary, disarmed aircraft." /><div className="sensor-kpis"><Kpi icon="⌁" label="IMU STATUS" value="DETECTED" detail="MPU6050 · 0x68" accent="lime" trend="10 Hz target" /><Kpi icon="◒" label="ATTITUDE FILTER" value="COMPLEMENTARY" detail="Pitch and roll only" accent="blue" trend="Advisory" /><Kpi icon="♨" label="TEMPERATURE" value={telemetry.temperature.toFixed(1) + " °C"} detail="Chip temperature" accent="orange" trend="Nominal" /></div><section className="dashboard-columns"><Panel eyebrow="RAW ACCELERATION · g" title="Accelerometer history" wide><TelemetryChart values={telemetry.acceleration.map((v, i) => 50 + v * 30 + i)} color="orange" /><div className="chart-footer"><span>X · {telemetry.acceleration[0].toFixed(3)}</span><span>Y · {telemetry.acceleration[1].toFixed(3)}</span><span>Z · {telemetry.acceleration[2].toFixed(3)}</span><span>Current sample</span></div></Panel><Panel eyebrow="SENSOR INVENTORY" title="Connected sources"><SensorRow name="MPU6050" state="Streaming" detail="I²C address 0x68" /><SensorRow name="Accelerometer" state="Streaming" detail="X / Y / Z · m/s²" /><SensorRow name="Gyroscope" state="Streaming" detail="X / Y / Z · deg/s" /><SensorRow name="GPS" state="Not installed" detail="No position source" /><SensorRow name="Battery divider" state="Not verified" detail="Values advisory" /></Panel></section><Panel eyebrow="MOUNTING & CALIBRATION" title="IMU alignment"><div className="calibration-row"><div className="orientation-box"><span>Requested mounting orientation</span><strong>X forward · Y right · Z down <span>⌄</span></strong><small>Saved orientation does not automatically reorient firmware readings.</small></div><div className="calibration-action"><span>No console calibration record</span><button className="primary-button" onClick={() => onAction("Calibration requires stationary, disarmed, explicitly supported firmware")}>Calibrate stationary IMU</button></div></div></Panel></>;
}

function Power({ telemetry }: { telemetry: Telemetry }) {
  return <><PageIntro eyebrow="AIRCRAFT SYSTEMS" title="Power systems" text="Battery status remains advisory until the physical divider, ground, calibration, and full-scale behavior are verified." /><div className="power-grid"><Panel eyebrow="AIRCRAFT BATTERY" title="Main propulsion pack"><div className="battery-big"><strong>{telemetry.voltage.toFixed(2)} <small>V</small></strong><div className="battery-bar"><i style={{ width: telemetry.battery + "%" }} /></div><div className="battery-detail"><span>Estimated state</span><b>{Math.round(telemetry.battery)}%</b></div><div className="battery-detail"><span>Calibration</span><b className="orange-text">Not verified</b></div></div></Panel><Panel eyebrow="SAFETY LIMITS" title="Power observations"><HealthRow label="ADC saturation" value="Clear" detail="A0 below full scale" tone="green" /><HealthRow label="Voltage divider" value="Advisory" detail="Physical verification required" tone="orange" /><HealthRow label="Low-voltage cutoff" value="Onboard only" detail="Not controlled by browser" tone="blue" /></Panel></div><div className="note-card"><span>◇</span><div><strong>Power is a flight-critical boundary</strong><p>Never connect a battery directly to NodeMCU A0 or Nano analog inputs. Use a measured divider and confirm the ratio with a multimeter before enabling alerts.</p></div></div></>;
}

function Preflight({ checks, toggleCheck, onAction }: { checks: Record<string, boolean>; toggleCheck: (key: string) => void; onAction: (message: string) => void }) {
  const items = [["battery", "Battery condition", "Inspect pack, connectors and mounting; verify chemistry and thresholds."], ["controls", "Control directions & travel", "Verify both ailerons, elevator and rudder without binding."], ["mixing", "Mixing configuration", "Confirm aircraft-applied configuration, including servo direction."], ["sensors", "Sensor orientation & calibration", "Keep the aircraft stationary and confirm the verified mounting."], ["radio", "Radio-link check", "Perform a physical range check with the propeller removed."], ["authorization", "Local flight authorization", "Confirm the receiver owns control and the browser remains read-only."]];
  const complete = items.filter(([key]) => checks[key]).length;
  return <><PageIntro eyebrow="FLIGHT SAFETY" title="Preflight checklist" text="A deliberate check before every departure. Operator completion is not proof of aircraft readiness." /><div className="alert-banner"><span className="warning-symbol">△</span><div><strong>Telemetry stale · current aircraft condition is unknown</strong><span>Automatically measured checks remain Unknown until a verified device source is connected.</span></div></div><section className="dashboard-columns"><Panel eyebrow={"OPERATOR-CONFIRMED CHECKS · " + complete + " / " + items.length} title="Bench gates"><div className="progress-track"><i style={{ width: (complete / items.length * 100) + "%" }} /></div>{items.map(([key, title, detail]) => <button className={checks[key] ? "check-item complete" : "check-item"} key={key} onClick={() => toggleCheck(key)}><span className="check-box">{checks[key] ? "✓" : ""}</span><div><strong>{title}</strong><span>{detail}</span></div><small>{checks[key] ? "DONE" : "OPEN"}</small></button>)}<button className="primary-button wide" onClick={() => onAction(complete === items.length ? "Checklist complete — local authorization still required" : "Complete all open gates first")}>Review readiness</button></Panel><Panel eyebrow="AUTOMATICALLY MEASURED CHECKS" title="System gates"><HealthRow label="Throttle-low condition" value="Unknown" detail="Requires verified input telemetry" tone="orange" /><HealthRow label="Radio-link check" value="Unknown" detail="Physical range check required" tone="orange" /><HealthRow label="IMU telemetry available" value="Unknown" detail="Presence does not prove accuracy" tone="orange" /><div className="operator-complete"><span>✓</span><div><strong>Operator checklist completed</strong><p>Automatic gates still require verified aircraft data.</p></div></div></Panel></section></>;
}

function Replay({ onAction }: { onAction: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [environment, setEnvironment] = useState("All environments");
  const sessions = [
    { name: "Control-surface checkout", date: "2026-09-11 09:30 UTC", samples: "600 samples", environment: "DEMO", duration: "10:00" },
    { name: "Gentle bank test", date: "2026-09-11 10:30 UTC", samples: "600 samples", environment: "DEMO", duration: "10:00" },
    { name: "Radio-loss simulation", date: "2026-09-11 11:30 UTC", samples: "600 samples", environment: "REPLAY", duration: "10:00" },
  ];
  const filtered = sessions.filter((session) => session.name.toLowerCase().includes(query.toLowerCase()) && (environment === "All environments" || session.environment === environment));
  const cycleEnvironment = () => {
    const options = ["All environments", "DEMO", "REPLAY"];
    const next = options[(options.indexOf(environment) + 1) % options.length];
    setEnvironment(next);
    onAction("Showing " + next.toLowerCase() + " sessions");
  };
  return <><PageIntro eyebrow="RECORDED DATA" title="Flight logs & replay" text="Recordings preserve source and freshness metadata. Replay cannot control hardware or generate current aircraft alerts." /><div className="replay-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions or notes..." aria-label="Search recorded sessions" /><button className="select-button" onClick={cycleEnvironment}>{environment} <span>⌄</span></button><span>{filtered.length} {filtered.length === 1 ? "session" : "sessions"}</span></div><Panel eyebrow="SESSION LIBRARY" title="Recent recordings"><div className="session-list">{filtered.map((session) => <div className="session-row" key={session.name}><span className="session-icon">↺</span><div><strong>{session.name}</strong><span>{session.date} · {session.environment} · {session.samples} · {session.duration}</span></div><button className="small-button" onClick={() => onAction(session.name + " details opened")}>Details</button><button className="small-button" onClick={() => onAction(session.name + " opened in isolated replay")}>▶ Replay</button></div>)}{filtered.length === 0 && <div className="session-empty"><span>⌕</span><strong>No matching recordings</strong><small>Try a different name or environment.</small></div>}</div></Panel><div className="note-card"><span>ⓘ</span><div><strong>Replay is isolated</strong><p>Background tabs can miss telemetry. Uninterrupted onboard recording requires additional firmware and storage.</p></div></div></>;
}
function Settings({ onAction, accountEmail }: { onAction: (message: string) => void; accountEmail: string | null }) {
  const [tab, setTab] = useState("Aircraft profiles");
  const [aircraftName, setAircraftName] = useState("Falcon 01");
  const [aircraftId, setAircraftId] = useState("FD-001");
  const [profileName, setProfileName] = useState("Falcon · bench travel limits");
  const [browserTone, setBrowserTone] = useState(true);
  const tabs = ["Aircraft profiles", "Integration", "Access & storage", "Wiring reference"];

  const profilePanel = <section className="settings-reference-grid"><Panel eyebrow="AIRCRAFT CONFIGURATION" title="Aircraft configuration"><div className="settings-field"><label>Aircraft name</label><input className="settings-input" value={aircraftName} onChange={(event) => setAircraftName(event.target.value)} /></div><div className="settings-field"><label>Aircraft ID</label><input className="settings-input" value={aircraftId} onChange={(event) => setAircraftId(event.target.value.toUpperCase())} /><small>Must match the provisioned gateway ID.</small></div><button className="select-button settings-select" onClick={() => onAction("Telemetry rate is set to 10 Hz")}>10 Hz · standard dashboard <span>⌄</span></button><div className="setting-toggle-row"><span>Browser test tone · separate from voice</span><button className={browserTone ? "toggle on" : "toggle"} onClick={() => { setBrowserTone(!browserTone); onAction("Browser test tone " + (browserTone ? "disabled" : "enabled")); }} aria-pressed={browserTone}><i /></button></div><button className="outline-button wide" onClick={() => onAction(browserTone ? "Browser test tone played" : "Enable browser tone first")}>Test browser tone</button></Panel><Panel eyebrow="SAVED PROFILES" title="Saved profiles"><div className="settings-field"><label>Profile name</label><input className="settings-input" value={profileName} onChange={(event) => setProfileName(event.target.value)} /></div><button className="primary-button wide" onClick={() => onAction("Saved profile: " + profileName)}>Save named profile</button><div className="saved-profile"><strong>Falcon 01 · v1</strong><button className="text-button" onClick={() => onAction("Falcon 01 profile loaded")}>Load</button></div><button className="outline-button wide" onClick={() => onAction("Configuration export prepared")}>⇩ Export configuration</button></Panel></section>;

  const integrationPanel = <section className="settings-reference-grid"><Panel eyebrow="NODEMCU GATEWAY" title="Protected telemetry ingress"><div className="integration-hero"><span>⌁</span><div><strong>Aircraft gateway</strong><small>Nano RX → level shifter → NodeMCU → Supabase</small></div><i>READY TO PROVISION</i></div><div className="endpoint-box"><span>INGEST ROUTE</span><code>/functions/v1/device-ingest</code><button onClick={() => { navigator.clipboard?.writeText("/functions/v1/device-ingest"); onAction("Ingress route copied"); }}>Copy</button></div><Setting label="Transport" value="HTTPS · JSON" /><Setting label="Authentication" value="Server-side device key" /><Setting label="Target rate" value="10 Hz dashboard / buffered ingest" /><button className="primary-button wide" onClick={() => onAction("NodeMCU integration checklist opened")}>Open gateway checklist →</button></Panel><Panel eyebrow="TELEMETRY CONTRACT" title="Expected payload"><DataContractRow field="aircraftId" type="string" example="FD-001" /><DataContractRow field="aircraftVoltage" type="number" example="11.84" /><DataContractRow field="attitude" type="object" example="pitch / roll" /><DataContractRow field="accel · gyro" type="vectors" example="x / y / z" /><DataContractRow field="radio" type="counters" example="received / expected" /><div className="contract-note">Secrets never belong in browser code or public firmware. Provision the device key through the protected gateway workflow.</div></Panel></section>;

  const accessPanel = <section className="settings-reference-grid"><Panel eyebrow="OPERATOR ACCESS" title="Verified session"><div className="access-identity"><div className="operator-avatar large-avatar">{accountEmail ? accountEmail.slice(0, 2).toUpperCase() : "DM"}</div><div><strong>{accountEmail ?? "Interactive demo"}</strong><span>{accountEmail ? "Email OTP · verified operator" : "No protected aircraft data"}</span></div><i className={accountEmail ? "verified-state" : "demo-state"}>{accountEmail ? "VERIFIED" : "DEMO"}</i></div><Setting label="Authentication" value="Supabase one-time code" /><Setting label="Control permission" value="Observe only" /><Setting label="Actuator transport" value="Disabled in browser" /><button className="outline-button wide" onClick={() => onAction("Account security summary opened")}>Review session security</button></Panel><Panel eyebrow="DATA GOVERNANCE" title="Storage & exports"><HealthRow label="Row-level security" value="Enabled" detail="Aircraft data scoped to authenticated access" tone="green" /><HealthRow label="Session recordings" value="Operator initiated" detail="Source and freshness retained" tone="blue" /><HealthRow label="Retention policy" value="30 days" detail="Change in backend policy" tone="orange" /><Setting label="Export format" value="JSON configuration / CSV telemetry" /><button className="primary-button wide" onClick={() => onAction("Account data export prepared")}>Prepare data export</button></Panel></section>;

  const wiringPanel = <section className="settings-reference-grid"><Panel eyebrow="SIGNAL PATH" title="Wiring reference"><WiringRow from="Nano TX" pin="SPI" to="nRF24L01+" detail="3.3 V module · common ground" /><WiringRow from="Nano RX" pin="UART TX" to="Level shifter HV" detail="5 V logic side" /><WiringRow from="Level shifter LV" pin="UART RX" to="NodeMCU" detail="3.3 V logic side" /><WiringRow from="NodeMCU" pin="D1 / D2" to="MPU6050" detail="I²C SCL / SDA · address 0x68" /><WiringRow from="Battery divider" pin="A0" to="NodeMCU" detail="Calibrated, ADC-safe voltage only" /></Panel><Panel eyebrow="POWER DOMAINS" title="Electrical boundaries"><div className="wiring-visual"><div><span>5 V</span><strong>Arduino Nano</strong><small>Transmitter / receiver logic</small></div><i>LEVEL<br />SHIFT</i><div><span>3.3 V</span><strong>NodeMCU + nRF24</strong><small>Gateway and radio domains</small></div></div><div className="alert-banner compact-alert"><span className="warning-symbol">△</span><div><strong>Do not feed 5 V logic into NodeMCU pins</strong><span>Verify level-shifter direction, shared ground, divider ratio and regulator capacity on the bench.</span></div></div><button className="outline-button wide" onClick={() => onAction("Wiring reference marked for bench review")}>Mark for bench review</button></Panel></section>;

  return <><div className="settings-page-head"><PageIntro eyebrow="FLIGHT OPERATIONS / DEMO" title="Profiles & settings" text="Aircraft identity, saved configuration, protected integration and hardware reference." /><div className="settings-toolbar"><button className="select-button" onClick={() => onAction("Gentle roll and pitch preset selected")}>Gentle roll & pitch <span>⌄</span></button><button className="outline-button" onClick={() => onAction("Configuration saved locally for this session")}>▣ Save changes</button><button className="primary-button" onClick={() => onAction("Session recording started")}>● Record session</button></div></div><div className="settings-tabs" role="tablist">{tabs.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "selected" : ""} onClick={() => { setTab(item); onAction(item + " selected"); }}>{item}</button>)}</div>{tab === "Aircraft profiles" ? profilePanel : tab === "Integration" ? integrationPanel : tab === "Access & storage" ? accessPanel : wiringPanel}</>;
}
function AuthLoading() {
  return <div className="auth-screen auth-loading"><div className="auth-brand-mark"><img src={assetUrl("flight-deck-mark.svg")} alt="" /></div><div className="eyebrow lime">FLIGHT DECK</div><span>Preparing secure operator access…</span></div>;
}

function AuthScreen({ onDemo, onSignedIn }: { onDemo: () => void; onSignedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [codeDigits, setCodeDigits] = useState<string[]>(Array(6).fill(""));
  const [codeSent, setCodeSent] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const requestCode = async () => {
    if (!email.trim()) {
      setMessage("Enter your operator email address.");
      return;
    }
    setBusy(true);
    const error = await sendMagicLink(email.trim());
    setBusy(false);
    if (error) {
      setMessage(error);
    } else {
      setCodeDigits(Array(6).fill(""));
      setCodeSent(true);
      setMessage("Enter the 6-digit code sent to your inbox.");
      window.setTimeout(() => document.getElementById("otp-0")?.focus(), 80);
    }
  };

  const verifyCode = async () => {
    const code = codeDigits.join("");
    if (code.length !== 6) {
      setMessage("Enter all 6 digits.");
      return;
    }
    setBusy(true);
    const result = await verifyEmailCode(email.trim(), code);
    setBusy(false);
    if (result.error) setMessage(result.error);
    else onSignedIn(result.email);
  };

  const updateDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    setCodeDigits((current) => current.map((item, itemIndex) => itemIndex === index ? digit : item));
    if (digit && index < 5) document.getElementById("otp-" + (index + 1))?.focus();
  };

  const pasteCode = (event: ClipboardEvent<HTMLDivElement>) => {
    const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!digits) return;
    event.preventDefault();
    setCodeDigits(Array.from({ length: 6 }, (_, index) => digits[index] ?? ""));
    document.getElementById("otp-" + Math.min(digits.length, 5))?.focus();
  };

  return <div className="auth-screen">
    <div className="auth-hero">
      <div className="auth-brand"><span className="auth-logo"><img src={assetUrl("flight-deck-mark.svg")} alt="" /></span><strong>FLIGHT DECK</strong></div>
      <div className="eyebrow lime">FIXED-WING OPERATIONS</div>
      <h1>Clarity on every<br /><em>control surface.</em></h1>
      <p>One workspace for aircraft telemetry, radio diagnostics, and deliberate preflight checks.</p>
      <div className="auth-aircraft"><img className="auth-aircraft-image" src={assetUrl("falcon-aircraft.svg")} alt="Falcon 01 fixed-wing aircraft" /><small>LOCAL CONTROL FIRST</small></div>
      <div className="auth-footer">♢ Physical radio control and aircraft failsafes stay onboard.</div>
    </div>
    <section className="auth-card">
      <div className="auth-card-icon">✉</div>
      {!codeSent ? <><div className="eyebrow lime">SECURE OPERATOR ACCESS</div><h2>Sign in to Flight Deck</h2><p>Enter your email to receive a one-time verification code.</p><input className="auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") requestCode(); }} placeholder="operator@example.com" autoComplete="email" /><button className="primary-button wide" onClick={requestCode} disabled={busy}>{busy ? "Sending..." : "Send verification code →"}</button></> : <><div className="eyebrow lime">SECURE OPERATOR ACCESS</div><h2>Check your inbox</h2><p>Enter the verification code sent to <strong>{email}</strong>.</p><div className="code-grid" onPaste={pasteCode}>{codeDigits.map((digit, index) => <input id={"otp-" + index} key={index} className="code-cell" type="text" inputMode="numeric" maxLength={1} value={digit} onChange={(event) => updateDigit(index, event.target.value)} onKeyDown={(event) => { if (event.key === "Backspace" && !digit && index > 0) document.getElementById("otp-" + (index - 1))?.focus(); if (event.key === "Enter") verifyCode(); }} aria-label={"Verification digit " + (index + 1)} autoComplete={index === 0 ? "one-time-code" : "off"} />)}</div><button className="primary-button wide" onClick={verifyCode} disabled={busy}>{busy ? "Verifying..." : "Verify & enter workspace →"}</button><div className="auth-inline-actions"><button className="text-button" onClick={() => { setCodeSent(false); setCodeDigits(Array(6).fill("")); setMessage(""); }}>Change email</button><button className="text-button" onClick={requestCode} disabled={busy}>Resend code</button></div></>}
      {message && <div className="auth-message">{message}</div>}
      <div className="auth-divider" />
      <button className="outline-button wide" onClick={onDemo}>Explore the interactive demo</button>
      <small className="auth-safety">Demo data is simulated. Protected aircraft data requires a verified account.</small>
    </section>
  </div>;
}
function SignInModal({ accountEmail, onClose, onSignedIn, onSignedOut }: { accountEmail: string | null; onClose: () => void; onSignedIn: (email: string) => void; onSignedOut: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const requestLink = async () => {
    if (!email.trim()) {
      setMessage("Enter your operator email address.");
      return;
    }
    setBusy(true);
    const error = await sendMagicLink(email.trim());
    setBusy(false);
    setMessage(error ?? "A 6-digit verification code was sent to your email.");
    if (!error) setCodeSent(true);
  };

  const verifyCode = async () => {
    if (code.length !== 6) {
      setMessage("Enter the full 6-digit code.");
      return;
    }
    setBusy(true);
    const result = await verifyEmailCode(email.trim(), code);
    setBusy(false);
    setMessage(result.error ?? "Verified successfully.");
    if (!result.error) onSignedIn(result.email);
  };

  const signOut = async () => {
    await supabase?.auth.signOut();
    onSignedOut();
    onClose();
  };

  return <div className="auth-backdrop" onClick={onClose}>
    <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="sign-in-title" onClick={(event) => event.stopPropagation()}>
      <button className="auth-close" onClick={onClose} aria-label="Close sign in">×</button>
      <div className="eyebrow lime">FLIGHT DECK ACCESS</div>
      <h2 id="sign-in-title">{accountEmail ? "Operator session" : "Sign in to Flight Deck"}</h2>
      {accountEmail ? <><p className="auth-copy">Authenticated operator session</p><div className="auth-account"><span className="online-dot" />{accountEmail}</div><button className="primary-button wide" onClick={signOut}>Sign out</button></> : <><p className="auth-copy">Enter your email to receive a 6-digit Supabase verification code.</p><input className="auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@example.com" autoComplete="email" /><button className="primary-button wide" onClick={requestLink} disabled={busy}>{busy ? "Sending..." : codeSent ? "Resend code" : "Send 6-digit code →"}</button>{codeSent && <><input className="auth-input code-input" type="text" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" autoComplete="one-time-code" /><button className="outline-button wide" onClick={verifyCode} disabled={busy}>{busy ? "Verifying..." : "Verify code →"}</button></>}{message && <div className="auth-message">{message}</div>}<small className="auth-safety">The browser is read-only. Authentication does not enable actuator control.</small></>}
    </section>
  </div>;
}

function PageIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <div className="page-intro"><div className="eyebrow lime">{eyebrow}</div><h2>{title}</h2><p>{text}</p></div>;
}

function Panel({ eyebrow, title, action, onAction, children, wide }: { eyebrow: string; title: string; action?: string; onAction?: () => void; children: ReactNode; wide?: boolean }) {
  return <section className={wide ? "panel wide-panel" : "panel"}><div className="panel-head"><div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div>{action && <button className="text-button" onClick={onAction}>{action}</button>}</div>{children}</section>;
}

function Kpi({ icon, label, value, detail, accent, trend }: { icon: string; label: string; value: string; detail: string; accent: string; trend: string }) {
  return <div className="kpi-card"><div className={"kpi-icon " + accent}>{icon}</div><div className="kpi-body"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><i className={"kpi-trend " + accent}>{trend}</i></div>;
}

function TelemetryChart({ values, color }: { values: number[]; color: string }) {
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * 100;
    const y = 82 - ((value - Math.min(...values)) / Math.max(Math.max(...values) - Math.min(...values), 1)) * 62;
    return x.toFixed(2) + "," + y.toFixed(2);
  }).join(" ");
  return <div className="telemetry-chart"><div className="chart-grid-lines"><i /><i /><i /><i /></div><svg viewBox="0 0 100 90" preserveAspectRatio="none"><defs><linearGradient id={"fill-" + color} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color === "lime" ? "#c6f36b" : color === "orange" ? "#ff9b68" : "#7cb8ff"} stopOpacity=".28" /><stop offset="100%" stopColor={color === "lime" ? "#c6f36b" : color === "orange" ? "#ff9b68" : "#7cb8ff"} stopOpacity="0" /></linearGradient></defs><polygon points={"0,90 " + points + " 100,90"} fill={"url(#fill-" + color + ")"} /><polyline points={points} fill="none" stroke={color === "lime" ? "#c6f36b" : color === "orange" ? "#ff9b68" : "#7cb8ff"} strokeWidth="1.8" vectorEffect="non-scaling-stroke" /></svg></div>;
}

function Joystick({ label, x, y, active }: { label: string; x: string; y: string; active?: boolean }) {
  return <div className="joystick"><span>{label}</span><div className={active ? "stick-pad active" : "stick-pad"}><i style={{ left: "50%", top: "50%", transform: "translate(calc(" + x + " * 100%), calc(" + y + " * -100%))" }} /></div><small>X {x} · Y {y}</small></div>;
}

function RangeRow({ label, value, setValue, suffix }: { label: string; value: number; setValue: (value: number) => void; suffix: string }) {
  return <div className="range-row"><div><span>{label}</span><b>{value}{suffix}</b></div><input type="range" min="0" max="100" value={value} onChange={(event) => setValue(Number(event.target.value))} /></div>;
}

function HealthRow({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <div className="health-row"><span className={"status-led " + tone} /><div><strong>{label}</strong><small>{detail}</small></div><b className={tone + "-text"}>{value}</b></div>;
}

function EventRow({ time, title, detail, tone }: { time: string; title: string; detail: string; tone: string }) {
  return <div className="event-row"><span className={"event-dot " + tone} /><time>{time}</time><div><strong>{title}</strong><span>{detail}</span></div></div>;
}

function Readout({ label, value }: { label: string; value: string }) {
  return <div className="readout"><span>{label}</span><strong>{value}</strong></div>;
}

function Instrument({ label, value, state }: { label: string; value: string; state: string }) {
  return <div className="instrument-row"><span>{label}</span><strong>{value}</strong><small>{state}</small></div>;
}

function ChannelRow({ number, name, input, command, warning }: { number: string; name: string; input: string; command: string; warning?: boolean }) {
  return <div className="channel-row"><b>{number}</b><strong>{name}</strong><span>{input}</span><span className={warning ? "orange-text" : ""}>{command}</span><small className={warning ? "tag orange-tag" : "tag green-tag"}>{warning ? "LOCKED" : "NOMINAL"}</small></div>;
}

function SensorRow({ name, state, detail }: { name: string; state: string; detail: string }) {
  return <div className="sensor-row"><span className={state === "Streaming" ? "status-led green" : "status-led orange"} /><strong>{name}</strong><span>{detail}</span><small>{state}</small></div>;
}

function Setting({ label, value }: { label: string; value: string }) {
  return <div className="setting-row"><span>{label}</span><strong>{value}</strong></div>;
}

function DataContractRow({ field, type, example }: { field: string; type: string; example: string }) {
  return <div className="contract-row"><code>{field}</code><span>{type}</span><strong>{example}</strong></div>;
}

function WiringRow({ from, pin, to, detail }: { from: string; pin: string; to: string; detail: string }) {
  return <div className="wiring-row"><div><strong>{from}</strong><small>{detail}</small></div><span>{pin}</span><i>→</i><b>{to}</b></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
