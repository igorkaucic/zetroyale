# ZET Royale

A tactical, high-precision public transit tracking system built specifically for the ZET 268 bus line in Zagreb.

Unlike the official schedule which is often inaccurate, ZET Royale reads directly from the live GTFS-RT (Real-Time) protocol feed to plot precise GPS locations of buses on a dynamic map.

## Core Features
- **Tactical Map UI**: Dark-mode Cyberpunk aesthetic using Leaflet mapping.
- **Directional Filtering**: Auto-detects whether you are heading to work or home based on your GPS location, and only locks onto buses traveling in the correct direction that haven't passed your stop yet.
- **Live Trajectory Calculation**: Computes live ETA, walking time to the stop, and provides a gamified "Buffer" countdown indicating if you need to run to catch the bus.
- **Sub-Minute Refresh**: Features exponential countdown smoothing so the timer ticks down naturally without jarring jumps when fresh GTFS data arrives.

## Architecture & Deployment (V2 - React PWA)

ZET Royale V2 is fundamentally restructuring from a client/server model into a **100% Client-Side Progressive Web App (PWA)** built with React, Vite, and TypeScript.

By moving all intelligence, protobuf decoding, and routing logic directly into the browser, we eliminate the need for a dedicated backend server.

### Deployment Strategy: The Hybrid Approach
The new architecture splits responsibilities for maximum efficiency and zero database costs:
1. **Frontend (GitHub Pages)**: A 100% static React 19 + Vite PWA. It handles all UI, heavy mathematical routing, and ETA calculations locally on the user's device.
2. **Backend Proxy (Node.js)**: A lightweight Node.js server that handles two critical jobs: 
    * Realtime: Downloads the GTFS-RT protobuf from ZET once every 10 seconds, decodes it to JSON, and caches it.
    * Static: Downloads the massive 71MB ZET GTFS static database on boot, parses over 1 million trip schedules into RAM, and serves lightning-fast queries via `/api/stops` and `/api/schedule`. All users ping this proxy instead of ZET directly, preventing rate-limiting and browser crashes.
3. **CI/CD Pipeline (deploy.ps1)**: All uploads are handled via a local PowerShell deployment script that automatically increments the semantic version number, builds the React app, and pushes it directly to GitHub Pages, ensuring the UI always reflects the exact production build version.

## Roadmap: V2 Hub-and-Spoke Architecture (The God Mode Upgrade)

ZET Royale is currently hardcoded for the 268 bus line. The V2 upgrade transforms it into a universal, personalized transit intelligence tool using a **Hub-and-Spoke topology**.

### The Intent
The goal is to personalize the tactical HUD for *any* user traversing Zagreb. Intelligence moves entirely to the **Client**. The user defines their own transit graph, and the React app processes a raw, unfiltered feed of all ZET vehicles from the Node proxy to provide real-time, personalized extraction data.

### Structural Changes
1.  **Dumb Proxy, Smart Client:** 
    *   The old Node.js backend is upgraded into a hybrid Real-time/Static engine.
    *   The React app fetches the live JSON feed of **all** active buses and trams from the proxy, doing all routing logic client-side.
2.  **Multi-Account Cloud Profiles:**
    *   The application architecture completely decouples personal transit graphs (Home, Hubs, Destinations) from the backend transit data proxy. 
    *   To achieve frictionless scaling, Google Identity is used exclusively for one-tap authentication (no Google Drive sync complexity).
    *   Upon login, the user's transit profile is instantly retrieved from a fast, lightweight database (SQLite/Postgres) attached to the Node.js proxy, instantly transforming the map into their personal transit grid.
3.  **Hub-and-Spoke Routing Logic:**
    *   **The Hub** is the structural invariant. Destinations always point to the Hub; the Hub always points Home. 
    *   Instead of guessing direction linearly, the client compares the user's active GPS coordinate against their graph. When at "Work", it locks onto lines heading towards the "Hub". When at the "Hub", it switches to lines heading "Home".
4.  **In-Memory Telemetry & Debugging:**
    *   All system logs, GPS polling events, and API fetches are routed to a centralized, ephemeral in-memory array (`window.SESSION_LOGS`).
    *   Logs are completely cleared upon page refresh to prevent memory leaks on mobile devices.
    *   A "Copy Log" button is integrated into the Settings UI, allowing developers to easily dump the active session state for rapid mobile debugging.
5.  **Generalized Tracking Math:**
    *   **Universal Direction Detection:** Moving away from hardcoded latitude checks (which fail for East-West trams) to **target-relative distance deltas**. "Is this vehicle getting closer to my active target stop, or further away?"
    *   **Client-Side ETAs:** The client will compute ETA and buffer times entirely in-browser using its own haversine implementation against the user's custom stop coordinates.
6.  **Omniscient Fleet Routing (The "God Mode" Solver):**
    *   Because the client now receives the live GPS state of *every tram and bus in the city simultaneously*, it acts as a dynamic routing mesh.
    *   **Continuous Autonomous Rerouting:** The engine does not just calculate a path once. It monitors the *entire* network continuously. If a faster route becomes available mid-journey due to traffic or delays, the math reroutes the user on the fly.
    *   **Explicit Multi-Leg Guidance:** When navigating multi-leg journeys, the UI provides full complete path visibility. It doesn't just say "Jump off here"—it explicitly states what the NEXT vehicle is, rendering its ghost position on the map, and giving the user exactly what they need for the next step of the transfer without them having to guess.
    *   **Predictive Transfer Synchronization:** The system evaluates intersecting routes to find the absolute fastest path to the active Hub or Destination. It computes transfer viability in real-time by calculating the active intersecting speeds of both vehicles, telling the user exact transfer windows based on how vehicles are *actually moving at this very second*.

### What Survives
The core visual and tactical identity of ZET Royale remains untouched. The Extraction Ring, smooth countdown blending, Phase system (TRAIN/WALK/EXTRACT), and map rendering carry over seamlessly — they will simply be ported to React components and fed dynamic data from the user's local topology.

## Phase 3: The HŽPP Train Integration Plan

While ZET provides both static schedules and live GTFS-RT (Real-Time) GPS feeds, HŽPP (Croatian Railways) only provides a static feed. The `https://www.hzpp.hr/GTFS_files.zip` file is the static baseline. It tells us *where* the stations are and *when* the trains are scheduled to arrive in a perfect world. It does not provide real-time tracking or delay data.

To integrate live HŽPP tracking into the tactical map, we must execute a two-step "Hybrid Injection" strategy:

1. **The Static Foundation (GTFS Parsing):**
   * Download and parse `GTFS_files.zip` into the Node.js proxy on startup.
   * Extract `stops.txt` (stations), `routes.txt` (lines), and `stop_times.txt` (schedules) into RAM.
   * This gives the React client the exact railway graph and the "theoretical" timetables.

2. **The Real-Time Hack (Delay Injection):**
   * Since there is no GTFS-RT feed, we must scrape live delays.
   * The Node proxy will actively poll the undocumented API behind the official HŽPP mobile app or the web-based "Vlakovi u pokretu / Kasni li vlak" (Is the train late?) portal.
   * We extract the live `delay_minutes` for active train IDs.
   * The proxy merges this delay integer with the static GTFS schedule in real-time. If a train is scheduled for 14:00 but has a +15 min delay, the proxy broadcasts its ETA as 14:15.
   * The React client then plots the train along the known railway geometry based on this time-shifted ETA, successfully simulating live GPS tracking for the tactical map.