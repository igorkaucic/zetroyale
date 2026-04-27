@echo off
title ZET Royale Dev Environment

echo Starting Backend GTFS Proxy...
start /b node server.js

echo Starting React Vite Frontend...
cd client
npm run dev
