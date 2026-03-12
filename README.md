# F9 Report Tool

Agent Performance & Connectivity Dashboard powered by the Five9 SOAP API. Fetch disposition and state reports, view per-agent metrics, and track performance hourly throughout the day.

![Dashboard](https://img.shields.io/badge/Five9-API%20Integration-5865F2?style=for-the-badge) ![Node.js](https://img.shields.io/badge/Node.js-Express-339933?style=for-the-badge) ![SQLite](https://img.shields.io/badge/SQLite-Cache-003B57?style=for-the-badge)

## Features

- **Five9 API Integration** — Fetch disposition & state reports directly via SOAP API
- **Hourly Reporting** — Query Five9 by specific hour ranges (e.g., 9 AM – 10 AM)
- **Cached Snapshots** — SQLite stores every hourly fetch for instant recall without re-hitting the API
- **Auto-Fetch Cron** — Automatically caches the previous hour's data at the top of every hour
- **Per-Agent Metrics** — Total available time, brute & effective connectivity, disposition breakdowns
- **Hourly Trend Chart** — Line chart showing performance across cached hours throughout the day
- **CSV Export** — Download agent summary as CSV
- **Discord Integration** — Send reports to Discord via webhook
- **Manual Upload** — Fallback CSV upload for offline use

## Quick Start

### 1. Clone & Install

```bash
git clone <repo-url>
cd F9-report-Tool
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
FIVE9_USERNAME=your_username
FIVE9_PASSWORD=your_password
FIVE9_FOLDER=My Reports
FIVE9_STATE_REPORT=Agent Daily State API
FIVE9_DISPO_REPORT=Agent Disposition by Day API
PORT=3000
```

### 3. Run

```bash
npm start
```

Open `http://localhost:3000` in your browser.

## How It Works

### Fetching Reports

1. Select a **date** and **hour range** (From / To dropdowns)
2. Use presets: **Full Day** (12 AM – 11 PM) or **Last Hour** (current hour)
3. Click **Fetch Reports** — data is fetched from Five9 and displayed
4. Single-hour fetches are **automatically cached** in SQLite

### Cached Hours Timeline

- Green pills show cached hours — click any to load instantly (no API call)
- The **Force Refresh** checkbox bypasses the cache to re-fetch from Five9
- Timeline updates automatically after each fetch

### Auto-Fetch Cron

The server runs a cron job every hour at `:00` that fetches the **previous** hour's data:
- At 5:00 PM → caches 4 PM data (the hour that just completed)
- Builds up a full day of cached snapshots automatically

### Hourly Trend Chart

Appears once 2+ hours are cached for a date. Shows:
- **Total Available Time** (right axis, purple)
- **Brute Connectivity** (left axis, blue)
- **Effective Connectivity** (left axis, green)

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/reports?date=&startHour=&endHour=&force=` | Fetch reports from Five9 (with cache) |
| `GET /api/snapshots?date=` | List cached hours for a date |
| `GET /api/snapshots/trends?date=` | Aggregated metrics per cached hour |
| `GET /api/snapshots/:hour?date=` | Get cached snapshot for a specific hour |

## Project Structure

```
├── server.js        # Express server, Five9 SOAP API, cron, endpoints
├── db.js            # SQLite database module (snapshots cache)
├── index.html       # Frontend dashboard (single-page app)
├── .env             # Five9 credentials & config
├── package.json     # Dependencies
└── reports.db       # SQLite database (auto-created on first run)
```

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, node-cron
- **Frontend:** Vanilla HTML/CSS/JS, Chart.js, PapaParse
- **API:** Five9 SOAP/XML AdminWebService v13
