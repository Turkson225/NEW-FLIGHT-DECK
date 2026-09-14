# FLIGHT DECK

A safety-conscious fixed-wing aircraft operations console for the NEW-FLIGHT-DECK repository.

This first build is a clean React + TypeScript dashboard foundation with:

- DEMO telemetry simulation for interface testing.
- LIVE mode that stays read-only until a separately validated onboard implementation exists.
- REPLAY mode for recorded-data workflows.
- Explicit stale and unknown telemetry states.
- Dashboard navigation for overview, live monitor, sensors, batteries, radio, preflight, replay, events, and settings.
- GitHub Pages deployment through GitHub Actions.

## Run locally

    npm install
    npm run dev

Build locally:

    npm run build

The production output is written to dist.

## GitHub Pages

The workflow in .github/workflows/pages.yml publishes the Vite build to:

https://turkson225.github.io/NEW-FLIGHT-DECK/

Enable GitHub Pages in repository Settings, choose GitHub Actions as the source, and push to main.

## Safety boundary

This interface is not a validated autopilot and does not provide guaranteed emergency control over an aircraft. The browser never queues actuator commands and never replays expired commands. Real-time radio reception, actuator output, failsafe behavior, watchdogs, and flight authorization must remain onboard.

No live actuator transport is enabled in this release.

## Next integration steps

1. Add the NodeMCU MPU6050 telemetry client.
2. Add the Nano transmitter and receiver contracts.
3. Add Supabase authentication and protected telemetry persistence.
4. Add verified device ingest through an Edge Function.
5. Validate every physical sensor, power rail, PWM output, and failsafe on a propeller-removed bench.
