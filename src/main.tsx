import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { cloudRequest, sendMagicLink, supabase, supabaseConfigured, verifyEmailCode } from "./lib/supabase";

type Page = "overview" | "monitor" | "mixer" | "sensors" | "power" | "preflight" | "replay" | "settings";
type Mode = "DEMO" | "LIVE" | "REPLAY";
type ChartKey = "link" | "acceleration" | "angular";

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
  { id: "overview" as Page, label: "Mission overview", icon: "⌂", section: "COMMAND" },
  { id: "monitor" as Page, label: "Live flight monitor", icon: "◉", section: "COMMAND", badge: "LIVE" },
  { id: "mixer" as Page, label: "Channels & mixer", icon: "≋", section: "CONTROL" },
  { id: "sensors" as Page, label: "Sensors & calibration", icon: "⌁", section: "AIRCRAFT" },
  { id: "power" as Page, label: "Power systems", icon: "▣", section: "AIRCRAFT" },
  { id: "preflight" as Page, label: "Preflight checklist", icon: "✓", section: "OPERATIONS", badge: "6" },
  { id: "replay" as Page, label: "Flight logs & replay", icon: "↺", section: "OPERATIONS" },
  { id: "settings" as Page, label: "Profiles & settings", icon: "⚙", section: "SYSTEM" },
];

const pageTitles: Record<Page, string> = {
  overview: "Mission overview",
  monitor: "Live flight monitor",
  mixer: "Channels & mixer",
  sensors: "Sensors & calibration",
  power: "Power systems",
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
          <div className="brand-mark">FD</div>
          <div>
            <div className="brand-name">FLIGHT DECK</div>
            <div className="brand-caption">AEROSPACE OPERATIONS</div>
          </div>
          <button className="collapse-button" aria-label="Collapse navigation" aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? "›" : "‹"}</button>
        </div>

        <div className="aircraft-card-mini">
          <div className="eyebrow">ACTIVE AIRCRAFT</div>
          <div className="aircraft-name-row">
            <span className="aircraft-icon">✈</span>
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
          {page === "sensors" && <Sensors telemetry={telemetry} onAction={notify} />}
          {page === "power" && <Power telemetry={telemetry} />}
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
          <div className="hero-drone"><span className="drone-nose" /><span className="drone-wing left" /><span className="drone-wing right" /><span className="drone-tail" /></div>
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
            <div className="twin-grid" /><div className="twin-drone"><span className="twin-nose" /><span className="twin-wing left" /><span className="twin-wing right" /><span className="twin-tail left" /><span className="twin-tail right" /></div>
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
  return <><PageIntro eyebrow="FLIGHT OPERATIONS / DEMO" title="Channels & mixer" text="Trace every input. Understand every output. These are commanded PWM references, not measured servo angles." /><div className="mix-toolbar"><div className="preset-select">Gentle roll & pitch <span>⌄</span></div><button className="outline-button" onClick={() => onAction("Configuration saved locally for this session")}>▣ Save changes</button><button className="primary-button" onClick={() => onAction("Session recording started")}>● Record session</button></div><div className="mix-state-banner"><strong>{mixEnabled ? "Roll mixing" : "Independent ailerons"}</strong><span className="mix-confirmed">{mixEnabled ? "MIX ON" : "MIX OFF"}</span><small>Requested v1 / Simulator confirmed {mixEnabled ? "1" : "0"}</small></div><section className="dashboard-columns"><Panel eyebrow="INTERACTIVE SIMULATOR" title="Physical controller inputs" wide><div className="joysticks large"><Joystick label="JOYSTICK 1" x="0.03" y="0.09" /><Joystick label="JOYSTICK 2" x="0.23" y="0.58" active /></div><RangeRow label="Throttle slider · A6" value={throttle} setValue={setThrottle} suffix="%" /><div className="pot-row"><span>Potentiometer 1 · A4</span><b>42%</b><span>Potentiometer 2 · A5</span><b>68%</b></div></Panel><Panel eyebrow="COMMANDED POSITION" title="Aileron mixing"><div className="aileron-large"><div className="aileron-readout"><span>LEFT AILERON<strong>{Math.round(1500 + (mixEnabled ? mixStrength * 1.5 : 86))} <small>µs</small></strong></span><span>RIGHT AILERON<strong>{Math.round(1500 - (mixEnabled ? mixStrength * 1.5 : 86))} <small>µs</small></strong></span></div><div className="plane-control large-plane"><span className="plane-body" /><span className="plane-wing left" /><span className="plane-wing right" /><span className="plane-tail" /></div></div><div className="mix-rule"><span>L = common + roll</span><span>R = common − roll</span></div><RangeRow label="Mix strength" value={mixStrength} setValue={setMixStrength} suffix="%" /><div className="switch-row"><span><i className="status-led green" /> Aileron mixing</span><button className={mixEnabled ? "toggle on" : "toggle"} onClick={() => setMixEnabled(!mixEnabled)}><i /></button><b>{mixEnabled ? "MIX ON" : "MIX OFF"}</b></div></Panel></section><div className="channel-table"><div className="table-header"><span>CHANNEL</span><span>FUNCTION</span><span>INPUT</span><span>COMMAND</span><span>STATE</span></div><ChannelRow number="CH1" name="Elevator" input="Joystick 1 Y" command="1509 µs" /><ChannelRow number="CH2" name="Rudder" input="Joystick 1 X" command="1497 µs" /><ChannelRow number="CH3" name="Left aileron" input="Joystick 2 X" command="1586 µs" /><ChannelRow number="CH4" name="Right aileron" input="Joystick 2 Y" command="1414 µs" /><ChannelRow number="CH5" name="Throttle" input="Slider · A6" command={throttle + "%"} /><ChannelRow number="CH8" name="Parachute" input="Guarded event" command="LOCKED" warning /></div></>;
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
  const sessions = [["Control-surface checkout", "2026-09-11 09:30 UTC", "600 samples"], ["Gentle bank test", "2026-09-11 10:30 UTC", "600 samples"], ["Radio-loss simulation", "2026-09-11 11:30 UTC", "600 samples"]];
  return <><PageIntro eyebrow="RECORDED DATA" title="Flight logs & replay" text="Recordings preserve their source and freshness metadata. Replay cannot control hardware or generate current alerts." /><div className="replay-toolbar"><input placeholder="Search sessions or notes..." /><button className="select-button" onClick={() => onAction("Environment filter opened — DEMO sessions shown")}>All environments <span>⌄</span></button><span>3 sessions</span></div><Panel eyebrow="SESSION LIBRARY" title="Recent recordings"><div className="session-list">{sessions.map(([name, date, samples]) => <div className="session-row" key={name}><span className="session-icon">↺</span><div><strong>{name}</strong><span>{date} · DEMO · {samples}</span></div><button className="small-button" onClick={() => onAction("Session details opened")}>Details</button><button className="small-button" onClick={() => onAction("Replay opened in isolated mode")}>▶ Replay</button></div>)}</div></Panel><div className="note-card"><span>ⓘ</span><div><strong>Replay is isolated</strong><p>Background tabs can miss telemetry. Uninterrupted onboard recording requires additional firmware and storage.</p></div></div></>;
}

function Settings({ onAction, accountEmail }: { onAction: (message: string) => void; accountEmail: string | null }) {
  const [tab, setTab] = useState("Aircraft profiles");
  const [aircraftName, setAircraftName] = useState("Falcon 01");
  const [aircraftId, setAircraftId] = useState("FD-001");
  const [profileName, setProfileName] = useState("Falcon · bench travel limits");

  const tabs = ["Aircraft profiles", "Integration", "Access & storage", "Wiring reference"];

  return <><div className="settings-page-head"><PageIntro eyebrow="FLIGHT OPERATIONS / DEMO" title="Profiles & settings" text="Aircraft identity, saved configuration and integration." /><div className="settings-toolbar"><button className="select-button" onClick={() => onAction("Gentle roll and pitch preset selected")}>Gentle roll & pitch <span>⌄</span></button><button className="outline-button" onClick={() => onAction("Configuration saved locally for this session")}>▣ Save changes</button><button className="primary-button" onClick={() => onAction("Session recording started")}>● Record session</button></div></div><div className="settings-tabs">{tabs.map((item) => <button key={item} className={tab === item ? "selected" : ""} onClick={() => { setTab(item); onAction(item + " selected"); }}>{item}</button>)}</div>{tab === "Aircraft profiles" ? <section className="settings-reference-grid"><Panel eyebrow="AIRCRAFT CONFIGURATION" title="Aircraft configuration"><div className="settings-field"><label>Aircraft name</label><input className="settings-input" value={aircraftName} onChange={(event) => setAircraftName(event.target.value)} /></div><div className="settings-field"><label>Aircraft ID</label><input className="settings-input" value={aircraftId} onChange={(event) => setAircraftId(event.target.value.toUpperCase())} /><small>Must match the provisioned gateway ID.</small></div><button className="select-button settings-select" onClick={() => onAction("Telemetry rate: 10 Hz standard dashboard")}>10 Hz · standard dashboard <span>⌄</span></button><div className="setting-toggle-row"><span>Browser test tone · separate from voice</span><button className="toggle on" onClick={() => onAction("Browser test tone toggled")}><i /></button></div><button className="outline-button wide" onClick={() => onAction("Browser test tone played")}>Test browser tone</button></Panel><Panel eyebrow="SAVED PROFILES" title="Saved profiles"><div className="settings-field"><label>Profile name</label><input className="settings-input" value={profileName} onChange={(event) => setProfileName(event.target.value)} /></div><button className="primary-button wide" onClick={() => onAction("Saved profile: " + profileName)}>Save named profile</button><div className="saved-profile"><strong>Falcon 01 · v1</strong><button className="text-button" onClick={() => onAction("Falcon 01 profile loaded")}>Load</button></div><button className="outline-button wide" onClick={() => onAction("Configuration export prepared")}>⇩ Export configuration</button></Panel></section> : <section className="settings-reference-grid"><Panel eyebrow={tab.toUpperCase()} title={tab}><div className="settings-tab-notice"><span>◇</span><div><strong>{tab} workspace</strong><p>This area is ready for the same aircraft profile, access, and wiring workflows shown in the reference console.</p><button className="primary-button" onClick={() => onAction(tab + " workflow opened")}>Open {tab.toLowerCase()} →</button></div></div></Panel><Panel eyebrow="CLOUD CONNECTION" title="Supabase gateway"><Setting label="Project" value="Existing FLIGHT-DECK backend" /><Setting label="Session" value={accountEmail ?? "Sign in required"} /><Setting label="Device ingest" value="Server-authenticated" /></Panel></section>}</>;
}

function AuthLoading() {
  return <div className="auth-screen auth-loading"><div className="auth-brand-mark">✈</div><div className="eyebrow lime">FLIGHT DECK</div><span>Preparing secure operator access…</span></div>;
}

function AuthScreen({ onDemo, onSignedIn }: { onDemo: () => void; onSignedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
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
      setCodeSent(true);
      setMessage("Enter the 6-digit code sent to your inbox.");
    }
  };

  const verifyCode = async () => {
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
    setCode((current) => current.substring(0, index) + digit + current.substring(index + 1));
  };

  return <div className="auth-screen">
    <div className="auth-hero">
      <div className="auth-brand"><span className="auth-logo">✈</span><strong>FLIGHT DECK</strong></div>
      <div className="eyebrow lime">FIXED-WING OPERATIONS</div>
      <h1>Clarity on every<br /><em>control surface.</em></h1>
      <p>One workspace for aircraft telemetry, radio diagnostics, and deliberate preflight checks.</p>
      <div className="auth-aircraft"><span className="auth-plane">✈</span><small>LOCAL CONTROL FIRST</small></div>
      <div className="auth-footer">♢ Physical radio control and aircraft failsafes stay onboard.</div>
    </div>
    <section className="auth-card">
      <div className="auth-card-icon">✉</div>
      {!codeSent ? <><div className="eyebrow lime">SECURE OPERATOR ACCESS</div><h2>Sign in to Flight Deck</h2><p>Enter your email to receive a one-time verification code.</p><input className="auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@example.com" autoComplete="email" /><button className="primary-button wide" onClick={requestCode} disabled={busy}>{busy ? "Sending..." : "Send verification code →"}</button></> : <><div className="eyebrow lime">SECURE OPERATOR ACCESS</div><h2>Check your inbox</h2><p>Enter the verification code sent to <strong>{email}</strong>.</p><div className="code-grid">{Array.from({ length: 6 }, (_, index) => <input key={index} className="code-cell" type="text" inputMode="numeric" maxLength={1} value={code[index] ?? ""} onChange={(event) => updateDigit(index, event.target.value)} aria-label={"Verification digit " + (index + 1)} />)}</div><button className="primary-button wide" onClick={verifyCode} disabled={busy}>{busy ? "Verifying..." : "Verify & enter workspace →"}</button><div className="auth-inline-actions"><button className="text-button" onClick={() => { setCodeSent(false); setCode(""); setMessage(""); }}>Change email</button><button className="text-button" onClick={requestCode} disabled={busy}>Resend code</button></div></>}
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

createRoot(document.getElementById("root")!).render(<App />);
