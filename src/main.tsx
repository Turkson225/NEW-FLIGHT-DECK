import { useEffect, useMemo, useState, type ClipboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { cloudRequest, createAccount, requestPasswordReset, sendMagicLink, signInWithPassword, supabase, supabaseConfigured, updatePassword, verifyEmailCode } from "./lib/supabase";

type Page = "overview" | "monitor" | "mixer" | "modes" | "sensors" | "power" | "radio" | "preflight" | "replay" | "settings";
type Mode = "DEMO" | "LIVE" | "REPLAY";
type ChartKey = "link" | "acceleration" | "angular";

const assetUrl = (name: string) => `${import.meta.env.BASE_URL}${name}`;

function accountNameFor(email: string | null, metadata?: Record<string, unknown>): string | null {
  if (!email) return null;
  const metadataName = metadata?.full_name ?? metadata?.display_name;
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim();
  const emailName = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return emailName ? emailName.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Flight Deck Operator";
}

function initialsFor(name: string | null): string {
  if (!name) return "DM";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

type Telemetry = {
  timestamp: string;
  link: number;
  battery: number;
  voltage: number;
  transmitterVoltage: number;
  packetAge: number;
  retries: number;
  wifiRssi: number;
  pitch: number;
  roll: number;
  temperature: number;
  acceleration: number[];
  angular: number[];
  armed: boolean | null;
  flightMode: string | null;
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
  const voltage = value(frame?.aircraftVoltage);
  return {
    timestamp: frame?.receivedAt ? new Date(frame.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—",
    link: Math.max(0, Math.min(100, link)),
    battery: voltage > 0 ? Math.max(0, Math.min(100, ((voltage - 10.2) / 2.4) * 100)) : 0,
    voltage,
    transmitterVoltage: value(frame?.transmitterVoltage),
    packetAge: value(radio?.packetAge),
    retries: value(radio?.retries),
    wifiRssi: value(frame?.wifiRssi),
    pitch: value(frame?.attitude?.pitch),
    roll: value(frame?.attitude?.roll),
    temperature: value(frame?.chipTemp),
    acceleration: [value(frame?.accel?.x) / 9.80665, value(frame?.accel?.y) / 9.80665, value(frame?.accel?.z) / 9.80665],
    angular: [value(frame?.gyro?.x), value(frame?.gyro?.y), value(frame?.gyro?.z)],
    armed: typeof frame?.armed === "boolean" ? frame.armed : null,
    flightMode: typeof frame?.mode === "string" ? frame.mode : null,
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
  transmitterVoltage: 0,
  packetAge: 0,
  retries: 0,
  wifiRssi: 0,
  pitch: 0,
  roll: 0,
  temperature: 0,
  acceleration: [0, 0, 0],
  angular: [0, 0, 0],
  armed: null,
  flightMode: null,
};

function demoTelemetry(elapsedSeconds: number): Telemetry {
  const roll = 9.8 * Math.sin(elapsedSeconds / 7.5) + 1.4 * Math.sin(elapsedSeconds / 2.7);
  const pitch = 1.7 + 2.8 * Math.sin(elapsedSeconds / 9.2);
  const link = 99.45 + 0.35 * Math.sin(elapsedSeconds / 4.4);
  const voltage = 12.1 - Math.min(elapsedSeconds / 18000, .18) + .025 * Math.sin(elapsedSeconds / 5.5);
  const transmitterVoltage = 8.08 - Math.min(elapsedSeconds / 28000, .1) + .015 * Math.sin(elapsedSeconds / 8);
  const rollRadians = roll * Math.PI / 180;
  const pitchRadians = pitch * Math.PI / 180;
  return {
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    link,
    battery: Math.max(0, Math.min(100, ((voltage - 10.2) / 2.4) * 100)),
    voltage,
    transmitterVoltage,
    packetAge: 14 + Math.round(5 * (1 + Math.sin(elapsedSeconds / 3))),
    retries: Math.max(0, Math.round(12 + elapsedSeconds / 18)),
    wifiRssi: -58 + Math.round(3 * Math.sin(elapsedSeconds / 11)),
    pitch,
    roll,
    temperature: 32.4 + .4 * Math.sin(elapsedSeconds / 28),
    acceleration: [Math.sin(pitchRadians), -Math.sin(rollRadians), -Math.cos(rollRadians) * Math.cos(pitchRadians)],
    angular: [1.31 * Math.cos(elapsedSeconds / 7.5), .31 * Math.cos(elapsedSeconds / 9.2), .18 * Math.sin(elapsedSeconds / 6)],
    armed: true,
    flightMode: "Manual RC",
  };
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [authReady, setAuthReady] = useState(!supabaseConfigured);
  const [demoAccess, setDemoAccess] = useState(false);
  const [mode, setMode] = useState<Mode>("DEMO");
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [signal, setSignal] = useState<number[]>([98.8, 99.1, 99.3, 99.5, 99.4, 99.7, 99.6, 99.8, 99.5, 99.7, 99.6, 99.4, 99.8, 99.7, 99.6, 99.8, 99.5, 99.6]);
  const [chart, setChart] = useState<ChartKey>("link");
  const [mixEnabled, setMixEnabled] = useState(true);
  const [throttle, setThrottle] = useState(64);
  const [mixStrength, setMixStrength] = useState(58);
  const [notifications, setNotifications] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voice, setVoice] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
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
        const email = data.user?.email ?? null;
        setAccountEmail(email);
        setAccountName(accountNameFor(email, data.user?.user_metadata));
        setAuthReady(true);
      }
    }).catch(() => {
      if (active) setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const email = session?.user?.email ?? null;
      setAccountEmail(email);
      setAccountName(accountNameFor(email, session?.user?.user_metadata));
      if (event === "PASSWORD_RECOVERY") setRecoveryOpen(true);
      setAuthReady(true);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (mode === "DEMO") {
      const started = Date.now();
      setLiveStatus("demo");
      setToast("DEMO simulator active");
      const tick = () => {
        const elapsed = (Date.now() - started) / 1000;
        const next = demoTelemetry(elapsed);
        setTelemetry(next);
        setSignal((items) => [...items.slice(-29), Number(next.link.toFixed(2))]);
      };
      tick();
      const timer = window.setInterval(tick, 1000);
      return () => window.clearInterval(timer);
    }

    if (mode === "REPLAY") {
      setLiveStatus("replay");
      setTelemetry(initialTelemetry);
      setToast("REPLAY is isolated from hardware");
      return;
    }

    let active = true;
    const poll = async () => {
      if (!supabaseConfigured || !supabase) {
        setLiveStatus("not-configured");
        setTelemetry(initialTelemetry);
        setToast("LIVE needs the Supabase project variables");
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
        setSignal((items) => [...items.slice(-29), Number(next.link.toFixed(2))]);
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
    const started = Date.now();
    const tick = () => setSessionSeconds(Math.floor((Date.now() - started) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

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
      onSignedIn={(email, name) => { setAccountEmail(email); setAccountName(name ?? accountNameFor(email)); setDemoAccess(false); setToast("Signed in successfully"); }}
    />;
  }

  return (
    <div className={"app-shell" + (sidebarCollapsed ? " sidebar-collapsed" : "") + (mobileNavOpen ? " mobile-nav-open" : "") + (highContrast ? " high-contrast" : "")}>
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
            <div className="operator-avatar">{initialsFor(accountName)}</div>
            <div><strong>{accountName ?? "Demo operator"}</strong><span>{accountEmail ? "Verified operator" : "Interactive demo"}</span></div>
            <span className="operator-more">•••</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar flight-topbar">
          <div className="topbar-aircraft">
            <button className="mobile-menu" aria-label="Open menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(!mobileNavOpen)}>☰</button>
            <button className="desktop-collapse" aria-label="Toggle navigation" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>◫</button>
            <span className="topbar-aircraft-mark"><img src={assetUrl("flight-deck-mark.svg")} alt="" /></span>
            <div><strong>Falcon 01 <span>/ FD-001</span></strong><small>Fixed-wing · Custom nRF24 platform</small></div>
            <span className={"source-chip " + mode.toLowerCase()}><i className={liveStatus === "connected" || liveStatus === "demo" ? "status-led green" : "status-led orange"} />{mode === "DEMO" ? "Simulator" : mode === "LIVE" ? "Live link" : "Replay"}</span>
          </div>
          <div className="topbar-right">
            <button className="parachute-top-button" onClick={() => notify("Parachute control is locked in the browser")}><span>◇</span> Parachute</button>
            <button className={voice ? "top-icon-button selected" : "top-icon-button"} onClick={() => setVoice(!voice)} aria-label={voice ? "Mute voice alerts" : "Enable voice alerts"}>{voice ? "◉" : "◌"}</button>
            <button className="command-trigger" onClick={() => setCommandOpen(true)} aria-label="Open command center"><span>Search</span><kbd>⌘ K</kbd></button>
            <div className="mode-control" aria-label="Data source">
              {(["DEMO", "LIVE", "REPLAY"] as Mode[]).map((item) => (
                <button key={item} className={mode === item ? "mode-tab selected" : "mode-tab"} onClick={() => setMode(item)}>{item}</button>
              ))}
            </div>
            <button className={notifications ? "top-icon-button selected" : "top-icon-button"} onClick={() => setNotifications(!notifications)} aria-label="Notifications">♢</button>
            <button className={highContrast ? "top-icon-button selected" : "top-icon-button"} onClick={() => setHighContrast(!highContrast)} aria-label="Toggle enhanced contrast">☼</button>
            <button className="owner-chip" onClick={() => setAuthOpen(true)}>{accountEmail ? "OWNER" : "DEMO"}</button>
            {accountEmail && <button className="signout-button compact-signout" onClick={async () => { await supabase?.auth.signOut(); setAccountEmail(null); setAccountName(null); setDemoAccess(false); setToast("Signed out"); }}>Sign out</button>}
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
        {authOpen && <SignInModal accountEmail={accountEmail} accountName={accountName} onClose={() => setAuthOpen(false)} onSignedIn={(email, name) => { setAccountEmail(email); setAccountName(name ?? accountNameFor(email)); setDemoAccess(false); setAuthOpen(false); notify("Signed in successfully"); }} onSignedOut={() => { setAccountEmail(null); setAccountName(null); setDemoAccess(false); notify("Signed out"); }} />}
        {recoveryOpen && <PasswordRecoveryModal onClose={() => setRecoveryOpen(false)} onComplete={() => { setRecoveryOpen(false); notify("Password updated successfully"); }} />}
          <div className="content">
          {page !== "overview" && <div className="context-bar">
            <div className="context-status"><span className={liveStatus === "connected" || liveStatus === "demo" ? "status-led green" : "status-led orange"} /><strong>{liveStatusLabel(liveStatus)}</strong><span>Falcon 01 · FD-001</span></div>
            <div className="context-actions">
              <button className="outline-button" onClick={() => notify("Control path is locked in the browser")}>◇ Control boundary</button>
              <button className="outline-button" onClick={() => notify("No unacknowledged live alerts")}>Alerts <span className="alert-count">3</span></button>
            </div>
          </div>}

          {notifications && <div className="notification-drawer"><strong>Station notifications</strong><span>All current alerts are simulator-only. No live device telemetry is verified.</span><button onClick={() => setNotifications(false)}>Dismiss</button></div>}

          {page === "overview" && (
            <Overview
              telemetry={telemetry}
              signal={signal}
              mode={mode}
              liveStatus={liveStatus}
              recording={recording}
              setRecording={setRecording}
              sessionSeconds={sessionSeconds}
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
  mode: Mode;
  liveStatus: LiveStatus;
  recording: boolean;
  setRecording: (value: boolean) => void;
  sessionSeconds: number;
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
  const { telemetry, signal, mode, liveStatus, recording, setRecording, sessionSeconds, chart, setChart, mixEnabled, setMixEnabled, throttle, setThrottle, mixStrength, setMixStrength, onNavigate, notify } = props;
  const hasSample = mode === "DEMO" || liveStatus === "connected" || liveStatus === "stale";
  const healthy = mode === "DEMO" || liveStatus === "connected";
  const duration = [Math.floor(sessionSeconds / 3600), Math.floor(sessionSeconds / 60) % 60, sessionSeconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
  const leftAileron = Math.max(0, Math.min(100, 50 + telemetry.roll * 2.3));
  const rightAileron = 100 - leftAileron;
  const elevator = Math.max(0, Math.min(100, 50 + telemetry.pitch * 4));
  const readiness = healthy ? 92 : liveStatus === "stale" ? 48 : 18;
  const sourceDetail = mode === "DEMO" ? "Deterministic simulator" : mode === "LIVE" ? liveStatusLabel(liveStatus) : "Recorded data only";

  return <>
    <div className="overview-page-head">
      <PageIntro eyebrow={"FLIGHT OPERATIONS / " + mode} title="Overview" text="Your aircraft, at a glance." />
      <div className="overview-toolbar">
        <button className="select-button" onClick={() => notify("Gentle roll & pitch profile selected")}>Gentle roll & pitch <span>⌄</span></button>
        <button className="outline-button" onClick={() => notify("Dashboard configuration saved locally")}>▣ Save changes</button>
        <button className={recording ? "primary-button recording-active" : "primary-button"} onClick={() => { setRecording(!recording); notify(recording ? "Session recording stopped" : "Session recording started"); }}><span className={recording ? "record-dot pulse" : "record-dot"} />{recording ? "Recording session" : "Record session"}</button>
      </div>
    </div>

    <section className="flight-metric-grid">
      <FlightMetricCard label="Aircraft battery" value={hasSample ? telemetry.voltage.toFixed(2) : "—"} unit="V" detail={hasSample ? "3S LiPo · Above warning" : "Awaiting verified voltage"} icon="▣" tone="lime" />
      <FlightMetricCard label="Transmitter battery" value={hasSample ? telemetry.transmitterVoltage.toFixed(2) : "—"} unit="V" detail={hasSample ? "2S Li-ion · Independent pack" : "Nano UART data unavailable"} icon="◉" tone="blue" />
      <FlightMetricCard label="Radio packet delivery" value={hasSample ? telemetry.link.toFixed(1) : "—"} unit="%" detail={hasSample ? telemetry.retries + " retries · since session start" : "No current nRF24 sample"} icon="⌁" tone={healthy ? "lime" : "orange"} spark={signal} />
      <FlightMetricCard label="Session duration" value={duration} detail={recording ? "Recording active · browser session" : "Not verified airborne time"} icon="◷" tone={recording ? "orange" : "muted"} />
    </section>

    <section className="flight-board-grid">
      <section className="flight-board-card pfd-board">
        <header><div><span>PRIMARY FLIGHT DISPLAY</span><strong>Body attitude</strong></div><span className={healthy ? "instrument-chip active" : "instrument-chip"}><i className={healthy ? "status-led green" : "status-led orange"} />{hasSample ? "IMU ESTIMATE" : "NO DATA"}</span></header>
        <PrimaryFlightDisplay telemetry={telemetry} hasSample={hasSample} />
      </section>

      <section className="flight-board-card attitude-board">
        <header><div><span>AIRCRAFT DIGITAL TWIN</span><strong>Attitude visualization</strong></div><span className="board-caption">3D · BODY FRAME</span></header>
        <AircraftAttitude telemetry={telemetry} hasSample={hasSample} />
        <div className="attitude-metrics">
          <Readout label="ROLL RATE" value={hasSample ? telemetry.angular[0].toFixed(1) + " °/s" : "—"} />
          <Readout label="PITCH RATE" value={hasSample ? telemetry.angular[1].toFixed(1) + " °/s" : "—"} />
          <Readout label="THROTTLE CMD" value={hasSample ? throttle + " %" : "—"} />
        </div>
      </section>

      <section className="flight-board-card health-board">
        <header><div><span>SYSTEM STATUS</span><strong>Aircraft health</strong></div><span className={healthy ? "health-shield healthy" : "health-shield"}>◇</span></header>
        <div className="aircraft-health-list">
          <AircraftHealthRow label="nRF24 radio" state={healthy ? "Healthy" : "Unknown"} tone={healthy ? "green" : "orange"} />
          <AircraftHealthRow label="Nano ↔ NodeMCU" state={healthy ? "Healthy" : "Unknown"} tone={healthy ? "green" : "orange"} />
          <AircraftHealthRow label="Onboard Wi-Fi" state={mode === "DEMO" ? "Simulated" : telemetry.wifiRssi ? telemetry.wifiRssi + " dBm" : "Unknown"} tone={healthy ? "green" : "orange"} />
          <AircraftHealthRow label="MPU6050" state={hasSample ? "Healthy" : "Unknown"} tone={hasSample ? "green" : "orange"} />
          <AircraftHealthRow label="Control authority" state="Manual RC" tone="blue" />
          <AircraftHealthRow label="Arm state" state={telemetry.armed === null ? "Unknown" : telemetry.armed ? "ARMED" : "DISARMED"} tone={telemetry.armed ? "orange" : telemetry.armed === false ? "green" : "gray"} />
        </div>
        <button className="board-link" onClick={() => onNavigate("sensors")}>Open sensor diagnostics <span>→</span></button>
      </section>

      <section className="flight-board-card readiness-board">
        <header><div><span>RECOVERY & SAFETY</span><strong>Readiness model</strong></div><span className="board-caption">{mode}</span></header>
        <div className="readiness-content">
          <div className="readiness-dial" style={{ background: `conic-gradient(var(--lime) ${readiness * 3.6}deg, rgba(198,243,107,.08) 0deg)` }}><div><strong>{readiness}%</strong><span>READY</span></div></div>
          <div className="readiness-list"><span><i className="status-led green" />Receiver failsafe <b>ONBOARD</b></span><span><i className={healthy ? "status-led green" : "status-led orange"} />Parachute feedback <b>{healthy ? "READY*" : "UNKNOWN"}</b></span><span><i className="status-led blue" />Browser control <b>LOCKED</b></span></div>
        </div>
        <small className="model-disclaimer">* {sourceDetail}. Confirm every safety item physically before flight.</small>
        <button className="board-link" onClick={() => onNavigate("preflight")}>Review preflight gates <span>→</span></button>
      </section>

      <section className="flight-board-card link-board">
        <header><div><span>RADIO TELEMETRY · 60 SECOND WINDOW</span><strong>Packet-delivery trend</strong></div><div className="chart-tabs">{(["link", "acceleration", "angular"] as ChartKey[]).map((item) => <button className={chart === item ? "chart-tab selected" : "chart-tab"} key={item} onClick={() => setChart(item)}>{item === "link" ? "Link" : item === "acceleration" ? "Acceleration" : "Angular"}</button>)}</div></header>
        <div className="link-chart-summary"><div><strong>{chart === "link" ? (hasSample ? telemetry.link.toFixed(1) + "%" : "—") : chart === "acceleration" ? telemetry.acceleration[2].toFixed(2) + " g" : telemetry.angular[0].toFixed(2) + " °/s"}</strong><span>{chart === "link" ? "CURRENT DELIVERY" : chart === "acceleration" ? "Z-AXIS ACCELERATION" : "ROLL RATE"}</span></div><span><i className={healthy ? "status-led green" : "status-led orange"} /> {sourceDetail}</span></div>
        <TelemetryChart values={chart === "link" ? signal : chart === "acceleration" ? signal.map((_, index) => 50 + Math.sin(index / 2.2) * 18) : signal.map((_, index) => 52 + Math.cos(index / 2.8) * 14)} color={chart === "link" ? "lime" : chart === "acceleration" ? "orange" : "blue"} />
        <div className="chart-footer"><span>60s ago</span><span>Target ≥ 90%</span><span>Warn &lt; 70%</span><span>NOW · {telemetry.timestamp}</span></div>
      </section>

      <section className="flight-board-card control-board">
        <header><div><span>CONTROL INPUTS</span><strong>Channel activity</strong></div><button className="board-link header-link" onClick={() => onNavigate("mixer")}>Open mixer →</button></header>
        <div className="control-activity-list">
          <ControlActivityRow label="Elevator" channel="CH1" value={elevator} />
          <ControlActivityRow label="Rudder" channel="CH2" value={50} />
          <ControlActivityRow label="Left aileron" channel="CH3" value={leftAileron} />
          <ControlActivityRow label="Right aileron" channel="CH4" value={rightAileron} />
          <ControlActivityRow label="Throttle" channel="CH5" value={throttle} accent />
        </div>
        <RangeRow label="Throttle simulator" value={throttle} setValue={setThrottle} suffix="%" />
        <div className="control-quick-row"><button className={mixEnabled ? "toggle on" : "toggle"} onClick={() => setMixEnabled(!mixEnabled)} aria-pressed={mixEnabled}><i /></button><span>Aileron mix {mixEnabled ? "active" : "inactive"}</span><label>Strength <b>{mixStrength}%</b></label><input aria-label="Mix strength" type="range" min="0" max="100" value={mixStrength} onChange={(event) => setMixStrength(Number(event.target.value))} /></div>
      </section>
    </section>

    <div className="overview-event-rail">
      <span className="event-rail-title">LIVE EVENT RAIL</span>
      <div><i className="event-dot green" /><time>{telemetry.timestamp}</time><strong>Telemetry synchronized</strong><span>{sourceDetail}</span></div>
      <div><i className="event-dot blue" /><time>NOW</time><strong>Control owner confirmed</strong><span>Physical transmitter · Manual RC</span></div>
      <div><i className="event-dot orange" /><time>SAFE</time><strong>Browser actuator path disabled</strong><span>Local receiver authority preserved</span></div>
      <button onClick={() => onNavigate("replay")}>View flight log →</button>
    </div>
  </>;
}

function FlightMetricCard({ label, value, unit, detail, icon, tone, spark }: { label: string; value: string; unit?: string; detail: string; icon: string; tone: string; spark?: number[] }) {
  const points = spark?.slice(-12).map((item, index, values) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const x = index / Math.max(values.length - 1, 1) * 100;
    const y = 20 - ((item - min) / Math.max(max - min, .01)) * 16;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return <article className={"flight-metric-card " + tone}><div className="flight-metric-top"><span>{label}</span><i>{icon}</i></div><div className="flight-metric-value"><strong>{value}</strong>{unit && <small>{unit}</small>}</div><div className="flight-metric-detail">{detail}</div>{points && <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} /></svg>}</article>;
}

function PrimaryFlightDisplay({ telemetry, hasSample }: { telemetry: Telemetry; hasSample: boolean }) {
  const roll = hasSample ? telemetry.roll : 0;
  const pitch = hasSample ? telemetry.pitch : 0;
  const ladderMarks = [-30, -20, -10, 0, 10, 20, 30];
  return <div className="pfd-screen">
    <div className="pfd-world" style={{ transform: `translate(-50%, calc(-50% + ${pitch * 4}px)) rotate(${-roll}deg)` }}><div className="pfd-sky" /><div className="pfd-ground" /><div className="pfd-horizon" /></div>
    <div className="pfd-bank-scale"><i className="bank-pointer" />{[-60, -30, 0, 30, 60].map((mark) => <span key={mark} style={{ transform: `rotate(${mark}deg)` }}><i /></span>)}</div>
    <div className="pfd-ladder" style={{ transform: `translate(-50%, calc(-50% + ${pitch * 4}px)) rotate(${-roll}deg)` }}>{ladderMarks.map((mark) => <div key={mark} className={mark === 0 ? "ladder-mark horizon-mark" : "ladder-mark"} style={{ top: (50 - mark * 1.35) + "%" }}><span>{Math.abs(mark)}</span><i /><span>{Math.abs(mark)}</span></div>)}</div>
    <div className="pfd-aircraft-symbol"><i /><span>○</span><i /></div>
    <div className="pfd-side-tape left"><span>SPD</span><strong>—</strong><small>NO AIRSPEED</small></div>
    <div className="pfd-side-tape right"><span>ALT</span><strong>—</strong><small>NO BARO</small></div>
    <div className="pfd-heading"><span>BODY HEADING</span><strong>REL —</strong></div>
    <div className="pfd-corner-data left"><span>ROLL</span><strong>{hasSample ? roll.toFixed(1) + "°" : "—"}</strong></div>
    <div className="pfd-corner-data right"><span>PITCH</span><strong>{hasSample ? pitch.toFixed(1) + "°" : "—"}</strong></div>
    <div className="pfd-source">MPU6050 · BODY ATTITUDE ONLY · NOT NAVIGATION</div>
  </div>;
}

function AircraftAttitude({ telemetry, hasSample }: { telemetry: Telemetry; hasSample: boolean }) {
  const roll = hasSample ? telemetry.roll : 0;
  const pitch = hasSample ? telemetry.pitch : 0;
  return <div className="aircraft-stage"><div className="stage-glow" /><div className="stage-floor" /><div className="stage-ring one" /><div className="stage-ring two" /><div className="aircraft-gimbal" style={{ transform: `perspective(650px) rotateX(${58 + pitch * .55}deg) rotateZ(${-roll}deg) translateY(${pitch * -.8}px)` }}><img src={assetUrl("falcon-aircraft.svg")} alt="Falcon 01 body-frame attitude model" /><span className="wing-trace left" /><span className="wing-trace right" /></div><div className="stage-axis"><span>X</span><span>Y</span><span>Z</span></div><small>BODY FRAME · NOT A NAVIGATION VIEW</small></div>;
}

function AircraftHealthRow({ label, state, tone }: { label: string; state: string; tone: string }) {
  return <div className="aircraft-health-row"><span>{label}</span><strong className={tone + "-text"}>{state}</strong></div>;
}

function ControlActivityRow({ label, channel, value, accent }: { label: string; channel: string; value: number; accent?: boolean }) {
  const clamped = Math.max(0, Math.min(100, value));
  return <div className="control-activity-row"><span>{channel}</span><strong>{label}</strong><div><i className={accent ? "accent" : ""} style={{ width: clamped + "%" }} /><b style={{ left: clamped + "%" }} /></div><small>{Math.round(clamped)}%</small></div>;
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

type AuthView = "signin" | "signup" | "code";
type AuthComplete = (email: string, name?: string) => void;

function AccountAccess({ onSignedIn, compact = false }: { onSignedIn: AuthComplete; compact?: boolean }) {
  const [view, setView] = useState<AuthView>("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [codeDigits, setCodeDigits] = useState<string[]>(Array(6).fill(""));
  const [codeSent, setCodeSent] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error" | "info">("info");
  const [busy, setBusy] = useState(false);

  const selectView = (next: AuthView) => {
    setView(next);
    setMessage("");
    setCodeSent(false);
    setCodeDigits(Array(6).fill(""));
  };

  const passwordSignIn = async () => {
    if (!email.trim() || !password) {
      setMessageTone("error");
      setMessage("Enter your email and password.");
      return;
    }
    setBusy(true);
    const result = await signInWithPassword(email.trim(), password);
    setBusy(false);
    if (result.error) {
      setMessageTone("error");
      setMessage(result.error);
    } else if (result.signedIn) {
      onSignedIn(result.email, result.name);
    }
  };

  const registerAccount = async () => {
    if (fullName.trim().length < 2) {
      setMessageTone("error");
      setMessage("Enter the account holder’s full name.");
      return;
    }
    if (!email.trim()) {
      setMessageTone("error");
      setMessage("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setMessageTone("error");
      setMessage("Use at least 8 characters for the password.");
      return;
    }
    if (password !== confirmPassword) {
      setMessageTone("error");
      setMessage("The passwords do not match.");
      return;
    }
    setBusy(true);
    const result = await createAccount(fullName.trim(), email.trim(), password);
    setBusy(false);
    if (result.error) {
      setMessageTone("error");
      setMessage(result.error);
    } else if (result.signedIn) {
      onSignedIn(result.email, result.name);
    } else {
      setView("signin");
      setPassword("");
      setConfirmPassword("");
      setMessageTone("success");
      setMessage("Account created. Check your inbox to confirm your email, then sign in.");
    }
  };

  const requestCode = async () => {
    if (!email.trim()) {
      setMessageTone("error");
      setMessage("Enter the email address for your account.");
      return;
    }
    setBusy(true);
    const error = await sendMagicLink(email.trim());
    setBusy(false);
    if (error) {
      setMessageTone("error");
      setMessage(error);
    } else {
      setCodeDigits(Array(6).fill(""));
      setCodeSent(true);
      setMessageTone("info");
      setMessage("Enter the 6-digit code sent to your inbox.");
      window.setTimeout(() => document.getElementById(compact ? "modal-otp-0" : "otp-0")?.focus(), 80);
    }
  };

  const verifyCode = async () => {
    const code = codeDigits.join("");
    if (code.length !== 6) {
      setMessageTone("error");
      setMessage("Enter all 6 digits.");
      return;
    }
    setBusy(true);
    const result = await verifyEmailCode(email.trim(), code);
    setBusy(false);
    if (result.error) {
      setMessageTone("error");
      setMessage(result.error);
    } else if (result.signedIn) {
      onSignedIn(result.email, result.name);
    }
  };

  const sendReset = async () => {
    if (!email.trim()) {
      setMessageTone("error");
      setMessage("Enter your email first, then choose Forgot password.");
      return;
    }
    setBusy(true);
    const error = await requestPasswordReset(email.trim());
    setBusy(false);
    setMessageTone(error ? "error" : "success");
    setMessage(error ?? "Password-reset link sent. Check your inbox.");
  };

  const updateDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    setCodeDigits((current) => current.map((item, itemIndex) => itemIndex === index ? digit : item));
    if (digit && index < 5) document.getElementById((compact ? "modal-otp-" : "otp-") + (index + 1))?.focus();
  };

  const pasteCode = (event: ClipboardEvent<HTMLDivElement>) => {
    const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!digits) return;
    event.preventDefault();
    setCodeDigits(Array.from({ length: 6 }, (_, index) => digits[index] ?? ""));
    document.getElementById((compact ? "modal-otp-" : "otp-") + Math.min(digits.length, 5))?.focus();
  };

  return <div className={compact ? "account-access compact" : "account-access"}>
    <div className="auth-tabs" role="tablist" aria-label="Account access options">
      <button role="tab" aria-selected={view === "signin"} className={view === "signin" ? "selected" : ""} onClick={() => selectView("signin")}>Sign in</button>
      <button role="tab" aria-selected={view === "signup"} className={view === "signup" ? "selected" : ""} onClick={() => selectView("signup")}>Create account</button>
      <button role="tab" aria-selected={view === "code"} className={view === "code" ? "selected" : ""} onClick={() => selectView("code")}>Email code</button>
    </div>

    {view === "signin" && <form className="auth-form" onSubmit={(event) => { event.preventDefault(); passwordSignIn(); }}>
      <div className="eyebrow lime">SECURE OPERATOR ACCESS</div>
      <h2>Welcome back</h2>
      <p>Sign in to open your protected aircraft workspace.</p>
      <label className="auth-field"><span>Email address</span><input className="auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@example.com" autoComplete="email" required /></label>
      <label className="auth-field"><span>Password</span><div className="password-input-wrap"><input className="auth-input" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label>
      <div className="auth-form-row"><label className="remember-label"><input type="checkbox" defaultChecked /> Keep me signed in</label><button type="button" className="text-button" onClick={sendReset} disabled={busy}>Forgot password?</button></div>
      <button className="primary-button wide" type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in →"}</button>
    </form>}

    {view === "signup" && <form className="auth-form" onSubmit={(event) => { event.preventDefault(); registerAccount(); }}>
      <div className="eyebrow lime">NEW OPERATOR ACCOUNT</div>
      <h2>Create your account</h2>
      <p>Register an operator identity for saved profiles and protected telemetry.</p>
      <label className="auth-field"><span>Full name</span><input className="auth-input" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your full name" autoComplete="name" required /></label>
      <label className="auth-field"><span>Email address</span><input className="auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@example.com" autoComplete="email" required /></label>
      <label className="auth-field"><span>Password</span><div className="password-input-wrap"><input className="auth-input" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Minimum 8 characters" autoComplete="new-password" minLength={8} required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label>
      <label className="auth-field"><span>Confirm password</span><input className="auth-input" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat your password" autoComplete="new-password" minLength={8} required /></label>
      <div className="password-strength"><i className={password.length >= 8 ? "complete" : ""} /><i className={password.length >= 10 ? "complete" : ""} /><i className={/[A-Z]/.test(password) && /\d/.test(password) ? "complete" : ""} /><span>{password.length < 8 ? "At least 8 characters" : password.length < 10 ? "Good password" : "Strong password"}</span></div>
      <button className="primary-button wide" type="submit" disabled={busy}>{busy ? "Creating account..." : "Create account →"}</button>
    </form>}

    {view === "code" && <div className="auth-form">
      <div className="eyebrow lime">PASSWORDLESS ACCESS</div>
      <h2>{codeSent ? "Check your inbox" : "Sign in with a code"}</h2>
      <p>{codeSent ? <>Enter the verification code sent to <strong>{email}</strong>.</> : "Use a one-time six-digit code for an existing account."}</p>
      {!codeSent ? <><label className="auth-field"><span>Email address</span><input className="auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") requestCode(); }} placeholder="operator@example.com" autoComplete="email" /></label><button className="primary-button wide" onClick={requestCode} disabled={busy}>{busy ? "Sending..." : "Send verification code →"}</button></> : <><div className="code-grid" onPaste={pasteCode}>{codeDigits.map((digit, index) => <input id={(compact ? "modal-otp-" : "otp-") + index} key={index} className="code-cell" type="text" inputMode="numeric" maxLength={1} value={digit} onChange={(event) => updateDigit(index, event.target.value)} onKeyDown={(event) => { if (event.key === "Backspace" && !digit && index > 0) document.getElementById((compact ? "modal-otp-" : "otp-") + (index - 1))?.focus(); if (event.key === "Enter") verifyCode(); }} aria-label={"Verification digit " + (index + 1)} autoComplete={index === 0 ? "one-time-code" : "off"} />)}</div><button className="primary-button wide" onClick={verifyCode} disabled={busy}>{busy ? "Verifying..." : "Verify & enter workspace →"}</button><div className="auth-inline-actions"><button className="text-button" onClick={() => { setCodeSent(false); setCodeDigits(Array(6).fill("")); setMessage(""); }}>Change email</button><button className="text-button" onClick={requestCode} disabled={busy}>Resend code</button></div></>}
    </div>}

    {message && <div className={"auth-message " + messageTone} role="status" aria-live="polite">{message}</div>}
    <small className="auth-safety">Authentication grants access to saved data only. Aircraft actuator control remains onboard.</small>
  </div>;
}

function AuthScreen({ onDemo, onSignedIn }: { onDemo: () => void; onSignedIn: AuthComplete }) {
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
      <div className="auth-card-icon">✦</div>
      <AccountAccess onSignedIn={onSignedIn} />
      <div className="auth-divider" />
      <button className="outline-button wide" onClick={onDemo}>Explore the interactive demo</button>
      <small className="auth-safety auth-demo-note">Demo data is simulated. Protected aircraft data requires an account.</small>
    </section>
  </div>;
}

function SignInModal({ accountEmail, accountName, onClose, onSignedIn, onSignedOut }: { accountEmail: string | null; accountName: string | null; onClose: () => void; onSignedIn: AuthComplete; onSignedOut: () => void }) {
  const signOut = async () => {
    await supabase?.auth.signOut();
    onSignedOut();
    onClose();
  };

  return <div className="auth-backdrop" onClick={onClose}>
    <section className={accountEmail ? "auth-modal session-modal" : "auth-modal access-modal"} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onClick={(event) => event.stopPropagation()}>
      <button className="auth-close" onClick={onClose} aria-label="Close account window">×</button>
      {accountEmail ? <><div className="eyebrow lime">FLIGHT DECK ACCOUNT</div><h2 id="account-dialog-title">Operator session</h2><div className="auth-account-profile"><div className="operator-avatar large-avatar">{initialsFor(accountName)}</div><div><strong>{accountName ?? accountNameFor(accountEmail)}</strong><span>{accountEmail}</span></div><i>VERIFIED</i></div><div className="session-security"><Setting label="Authentication" value="Supabase secure session" /><Setting label="Workspace access" value="Protected telemetry" /><Setting label="Aircraft commands" value="Browser disabled" /></div><button className="primary-button wide" onClick={signOut}>Sign out</button></> : <><div className="modal-brand-line"><img src={assetUrl("flight-deck-mark.svg")} alt="" /><div><span>FLIGHT DECK</span><small>OPERATOR ACCESS</small></div></div><h2 id="account-dialog-title" className="visually-hidden">Flight Deck account access</h2><AccountAccess compact onSignedIn={onSignedIn} /></>}
    </section>
  </div>;
}

function PasswordRecoveryModal({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const savePassword = async () => {
    if (password.length < 8) {
      setMessage("Use at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("The passwords do not match.");
      return;
    }
    setBusy(true);
    const error = await updatePassword(password);
    setBusy(false);
    if (error) setMessage(error);
    else onComplete();
  };

  return <div className="auth-backdrop recovery-backdrop">
    <section className="auth-modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <button className="auth-close" onClick={onClose} aria-label="Close password reset">×</button>
      <div className="auth-card-icon">◇</div><div className="eyebrow lime">ACCOUNT RECOVERY</div><h2 id="recovery-title">Choose a new password</h2><p className="auth-copy">Your recovery link is verified. Set a new password for this operator account.</p>
      <label className="auth-field"><span>New password</span><div className="password-input-wrap"><input className="auth-input" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} /><button onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide" : "Show"}</button></div></label>
      <label className="auth-field"><span>Confirm new password</span><input className="auth-input" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} /></label>
      {message && <div className="auth-message error" role="status">{message}</div>}
      <button className="primary-button wide" onClick={savePassword} disabled={busy}>{busy ? "Updating..." : "Update password →"}</button>
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
