# ZET Royale

A tactical, high-precision public transit tracking system built specifically for the ZET 268 bus line in Zagreb.

Unlike the official schedule which is often inaccurate, ZET Royale reads directly from the live GTFS-RT (Real-Time) protocol feed to plot precise GPS locations of buses on a dynamic map.

## Core Features
- **Tactical Map UI**: Dark-mode Cyberpunk aesthetic using Leaflet mapping.
- **Directional Filtering**: Auto-detects whether you are heading to work or home based on your GPS location, and only locks onto buses traveling in the correct direction that haven't passed your stop yet.
- **Live Trajectory Calculation**: Computes live ETA, walking time to the stop, and provides a gamified "Buffer" countdown indicating if you need to run to catch the bus.
- **Sub-Minute Refresh**: Features exponential countdown smoothing so the timer ticks down naturally without jarring jumps when fresh GTFS data arrives.

## Architecture & Deployment

ZET Royale is composed of:
1. A **Node.js Backend** (`server.cloud.js`) that constantly fetches and decodes the ZET protocol buffer feed, calculates speeds via haversine formulas, and tracks bus trajectories.
2. A **Vanilla JS / CSS Frontend** (`public/index.html`) that displays the data on a tactical HUD.

### Cloud Deployment Strategy
The app is fully decoupled from local infrastructure to allow monitoring on the go.

1. **Version Control**: Hosted on GitHub at `https://github.com/SubPhaser/zet-royale`.
2. **Cloud Hosting**: Deployed on **Render.com**. Render connects directly to the GitHub repository. Whenever code is pushed to the `main` branch, Render automatically detects the Node.js environment, rebuilds, and redeploys the app to a public HTTPS url.

This CI/CD pipeline ensures zero-downtime updates and eliminates the need to run local port forwarding or manage SSL certificates.

## Running Locally

If running locally for development:
\`\`\`bash
npm run dev
\`\`\`
This runs `server.js` using local self-signed certificates on port 3268.
