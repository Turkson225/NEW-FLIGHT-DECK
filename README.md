# FLIGHT DECK

A safety-conscious fixed-wing aircraft operations console for the NEW-FLIGHT-DECK repository.

The dashboard includes DEMO simulation, LIVE read-only telemetry, REPLAY isolation, channel/mixer visualization, sensor and battery pages, preflight checks, and a premium aerospace operations-console interface.

## Run locally

    npm install
    cp .env.example .env
    npm run dev

The repository is configured to use the existing FLIGHT-DECK Supabase project. The .env file may contain VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and optionally VITE_WORKSPACE_ID.

Build locally with npm run build.

## Existing Supabase connection

NEW-FLIGHT-DECK now uses the same Supabase project and protected Edge Functions as the original FLIGHT-DECK repository. No new Supabase project is required.

The GitHub Pages workflow has safe fallbacks for the existing project URL and publishable browser key. You may also add these repository Actions Variables:

- VITE_SUPABASE_URL
- VITE_SUPABASE_PUBLISHABLE_KEY
- VITE_WORKSPACE_ID (optional)

The publishable key is browser-safe. Never place a service-role key or DEVICE_SHARED_TOKEN in the frontend or GitHub Pages build.

The original project must already have its schema, flight-api function, telemetry-ingest function, and server-side device secrets configured. The schema and function files in this repository are a versioned reference for the new dashboard; do not run the migration against the existing production database unless you have confirmed those objects are missing.

## How LIVE telemetry works

    TX Nano → nRF24 + Receiver Nano → level shifter + NodeMCU → HTTPS telemetry-ingest → fd_telemetry → authenticated dashboard

In LIVE mode, the browser signs in with a Supabase magic link and polls flight-api every 2.5 seconds. If the operator is signed out, the device has not uploaded a verified sample, or telemetry is stale, the dashboard shows an explicit non-live state.

## GitHub Pages

The workflow in .github/workflows/pages.yml publishes to:

https://turkson225.github.io/NEW-FLIGHT-DECK/

## Safety boundary

This interface is not a validated autopilot and does not provide guaranteed emergency control over an aircraft. The browser never queues actuator commands and never replays expired commands. Real-time radio reception, actuator output, failsafe behavior, watchdogs, and flight authorization remain onboard.

Live parachute dispatch is deliberately disabled in this release. Validate the receiver, PWM outputs, power rails, failsafe, telemetry upload, and recovery system on a propeller-removed bench.
