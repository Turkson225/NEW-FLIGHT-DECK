# FLIGHT DECK

A safety-conscious fixed-wing aircraft operations console for the NEW-FLIGHT-DECK repository.

The dashboard includes DEMO simulation, LIVE read-only telemetry, REPLAY isolation, channel/mixer visualization, sensor and battery pages, preflight checks, and a premium aerospace operations-console interface.

## Run locally

    npm install
    cp .env.example .env
    npm run dev

Set VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and optionally VITE_WORKSPACE_ID in .env for the new Supabase project.

Build locally with npm run build.

## Create and connect the new Supabase project

1. Create a new Supabase project and copy its project URL and publishable browser key.
2. Run the schema in supabase/migrations/202609140001_new_flight_deck.sql with the Supabase SQL editor, or use the Supabase CLI.
3. Deploy both Edge Functions:

       supabase link --project-ref YOUR_PROJECT_REF
       supabase db push
       supabase functions deploy flight-api --no-verify-jwt
       supabase functions deploy telemetry-ingest --no-verify-jwt

4. Configure the Edge Function secrets. Never put these in the browser or GitHub Pages build:

       supabase secrets set \
         ALLOWED_ORIGINS=https://turkson225.github.io \
         DEVICE_ID=FD-001 \
         DEVICE_WORKSPACE_ID=YOUR_OWNER_USER_UUID \
         DEVICE_SHARED_TOKEN=GENERATE_A_RANDOM_TOKEN_AT_LEAST_32_CHARACTERS

The flight-api function uses the logged-in Supabase user and workspace membership. The telemetry-ingest function uses the device token and validates the NodeMCU payload before writing telemetry.

5. In GitHub repository Settings → Secrets and variables → Actions → Variables, add VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and optionally VITE_WORKSPACE_ID.

The Pages workflow injects these at build time. The publishable key is safe for browser use; service-role keys and device tokens are not.

## How LIVE telemetry works

    TX Nano → nRF24 + Receiver Nano → level shifter + NodeMCU → HTTPS telemetry-ingest → fd_telemetry → authenticated dashboard

The browser polls flight-api every 2.5 seconds in LIVE mode. If the project is not configured, the operator is signed out, or the NodeMCU has not uploaded a verified sample, the dashboard shows an explicit non-live state.

## GitHub Pages

The workflow in .github/workflows/pages.yml publishes to:

https://turkson225.github.io/NEW-FLIGHT-DECK/

## Safety boundary

This interface is not a validated autopilot and does not provide guaranteed emergency control over an aircraft. The browser never queues actuator commands and never replays expired commands. Real-time radio reception, actuator output, failsafe behavior, watchdogs, and flight authorization remain onboard.

Live parachute dispatch is deliberately disabled in this release. Validate the receiver, PWM outputs, power rails, failsafe, telemetry upload, and recovery system on a propeller-removed bench.
