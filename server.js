require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { saveSnapshot, getSnapshot, getAvailableHours, deleteSnapshotsAfterHour } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Five9 Config ─────────────────────────────────────────────
const FIVE9_USER = process.env.FIVE9_USERNAME;
const FIVE9_PASS = process.env.FIVE9_PASSWORD;
const FIVE9_FOLDER = process.env.FIVE9_FOLDER;
const FIVE9_STATE_REPORT = process.env.FIVE9_STATE_REPORT;
const FIVE9_DISPO_REPORT = process.env.FIVE9_DISPO_REPORT;
const FIVE9_API_URL = `https://api.five9.com/wsadmin/v13/AdminWebService`;

const basicAuth = Buffer.from(`${FIVE9_USER}:${FIVE9_PASS}`).toString('base64');

// ── Serve static files ──────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── SOAP Helpers ─────────────────────────────────────────────
function soapEnvelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ser="http://service.admin.ws.five9.com/">
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function soapRequest(body) {
    const res = await fetch(FIVE9_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml;charset=UTF-8',
            'Authorization': `Basic ${basicAuth}`,
        },
        body: soapEnvelope(body),
    });

    const text = await res.text();

    if (!res.ok) {
        // Extract fault message if possible
        const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
        const msg = faultMatch ? faultMatch[1] : `HTTP ${res.status}`;
        throw new Error(`Five9 SOAP Error: ${msg}`);
    }

    return text;
}

// ── Extract text from XML tag ────────────────────────────────
function extractTag(xml, tag) {
    const re = new RegExp(`<(?:[a-z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tag}>`, 'i');
    const m = xml.match(re);
    return m ? m[1].trim() : null;
}

// ── Run a Five9 Report ───────────────────────────────────────
// Accepts full ISO datetime strings for start/end
async function runFive9Report(reportName, startDateTime, endDateTime) {
    console.log(`  → Running report: "${reportName}" (${startDateTime} to ${endDateTime})`);

    // 1) runReport
    const runBody = `
    <ser:runReport>
      <folderName>${FIVE9_FOLDER}</folderName>
      <reportName>${reportName}</reportName>
      <criteria>
        <time>
          <end>${endDateTime}</end>
          <start>${startDateTime}</start>
        </time>
      </criteria>
    </ser:runReport>`;

    const runResponse = await soapRequest(runBody);
    const reportId = extractTag(runResponse, 'return');

    if (!reportId) {
        throw new Error(`No report ID returned for "${reportName}". Response: ${runResponse.substring(0, 500)}`);
    }
    console.log(`    Report ID: ${reportId}`);

    // 2) Poll isReportRunning
    let running = true;
    let attempts = 0;
    const MAX_ATTEMPTS = 60;

    while (running && attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 2000)); // wait 2s between polls

        const pollBody = `
      <ser:isReportRunning>
        <identifier>${reportId}</identifier>
        <timeout>5</timeout>
      </ser:isReportRunning>`;

        const pollResponse = await soapRequest(pollBody);
        const result = extractTag(pollResponse, 'return');
        running = result === 'true';
        console.log(`    Poll #${attempts}: running=${result}`);
    }

    if (running) {
        throw new Error(`Report "${reportName}" timed out after ${MAX_ATTEMPTS} polls`);
    }

    // 3) getReportResultCsv
    const csvBody = `
    <ser:getReportResultCsv>
      <identifier>${reportId}</identifier>
    </ser:getReportResultCsv>`;

    const csvResponse = await soapRequest(csvBody);
    const csvData = extractTag(csvResponse, 'return');

    if (!csvData) {
        throw new Error(`No CSV data returned for "${reportName}"`);
    }

    console.log(`    ✅ Got CSV data (${csvData.length} chars)`);
    return csvData;
}

// ── Build datetime strings ───────────────────────────────────
function buildDateTimes(date, startHour, endHour) {
    const sh = String(startHour).padStart(2, '0');
    const eh = String(endHour).padStart(2, '0');
    const startDateTime = `${date}T${sh}:00:00.000-04:00`;
    const endDateTime = `${date}T${eh}:59:59.000-04:00`;
    return { startDateTime, endDateTime };
}

// ── Fetch from Five9 for a specific hour range ───────────────
async function fetchHourlyReports(date, startHour, endHour) {
    const { startDateTime, endDateTime } = buildDateTimes(date, startHour, endHour);

    console.log(`\n📊 Fetching Five9 reports: ${date} ${startHour}:00 → ${endHour}:59`);

    const [stateCSV, dispoCSV] = await Promise.all([
        runFive9Report(FIVE9_STATE_REPORT, startDateTime, endDateTime),
        runFive9Report(FIVE9_DISPO_REPORT, startDateTime, endDateTime),
    ]);

    return { stateCSV, dispoCSV };
}

// ── API: Fetch reports (with optional hourly range) ──────────
app.get('/api/reports', async (req, res) => {
    try {
        const date = req.query.date || getTodayDateEDT();
        const startHour = req.query.startHour !== undefined ? parseInt(req.query.startHour) : 0;
        const endHour = req.query.endHour !== undefined ? parseInt(req.query.endHour) : 23;
        const forceRefresh = req.query.force === 'true';

        // For single-hour requests, check cache first
        if (startHour === endHour && !forceRefresh) {
            const cached = getSnapshot(date, startHour);
            if (cached) {
                console.log(`📦 Cache hit: ${date} hour ${startHour}`);
                return res.json({
                    stateCSV: cached.state_csv,
                    dispoCSV: cached.dispo_csv,
                    date,
                    startHour,
                    endHour,
                    cached: true,
                    cachedAt: cached.created_at,
                });
            }
        }

        // Fetch from Five9
        const { stateCSV, dispoCSV } = await fetchHourlyReports(date, startHour, endHour);

        // Cache single-hour results
        if (startHour === endHour) {
            saveSnapshot(date, startHour, stateCSV, dispoCSV);
            console.log(`💾 Cached snapshot: ${date} hour ${startHour}`);
        }

        res.json({ stateCSV, dispoCSV, date, startHour, endHour, cached: false });
    } catch (err) {
        console.error('❌ Error fetching reports:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── API: Get available cached hours for a date ───────────────
app.get('/api/snapshots', (req, res) => {
    const date = req.query.date || getTodayDateEDT();
    const hours = getAvailableHours(date);
    res.json({ date, hours });
});

// ── API: Hourly trend data (aggregated metrics per hour) ─────
app.get('/api/snapshots/trends', (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const hours = getAvailableHours(date);

    if (hours.length === 0) {
        return res.json({ date, trends: [] });
    }

    const EFFECTIVE_COLS = [
        'ADP / CALLS count',
        '-Future / CALLS count',
        '-Same Or Next Day / CALLS count',
        'Call Back / CALLS count',
        'Not Interested / CALLS count',
    ];
    const BRUTE_COLS = [
        'HU / CALLS count', 'Wrong Number / CALLS count', 'DNC / CALLS count',
        'Kicked / CALLS count', 'Do Not Call / CALLS count', 'Sold House / CALLS count',
        'AC / CALLS count', 'Out of Area / CALLS count', 'Will Sell Property / CALLS count',
        'ONA / CALLS count', 'Out of Town / CALLS count', 'HOA / CALLS count',
        'Caller Disconnected / CALLS count', 'ANC / CALLS count', 'Sale / CALLS count',
        'Transferred To 3rd Party / CALLS count',
        ...EFFECTIVE_COLS,
    ];

    function timeToHours(str) {
        if (!str || typeof str !== 'string') return 0;
        const parts = str.trim().split(':');
        if (parts.length !== 3) return 0;
        const [h, m, s] = parts.map(Number);
        return h + m / 60 + s / 3600;
    }
    function safeNum(val) { const n = parseFloat(val); return isNaN(n) ? 0 : n; }

    // Need to dynamically require papaparse for server-side CSV parsing
    let Papa;
    try { Papa = require('papaparse'); } catch (e) {
        return res.status(500).json({ error: 'papaparse not installed on server' });
    }

    const trends = [];

    for (const { hour } of hours) {
        const snap = getSnapshot(date, hour);
        if (!snap) continue;

        const stateRows = Papa.parse(snap.state_csv, { header: true, skipEmptyLines: true }).data;
        const dispoRows = Papa.parse(snap.dispo_csv, { header: true, skipEmptyLines: true }).data;

        // Build state map
        const stateMap = {};
        stateRows.forEach(row => {
            const key = (row['AGENT'] || '').trim().toLowerCase();
            if (key) stateMap[key] = row;
        });

        let totalAvail = 0, totalDispositions = 0, effectiveDispositions = 0;

        dispoRows.forEach(dRow => {
            const key = (dRow['AGENT'] || '').trim().toLowerCase();
            const sRow = stateMap[key];
            if (!sRow) return;

            const onCallHrs = timeToHours(sRow['On Call / AGENT STATE TIME']);
            const readyHrs = timeToHours(sRow['Ready / AGENT STATE TIME']);
            totalAvail += onCallHrs + readyHrs;

            totalDispositions += BRUTE_COLS.reduce((sum, col) => sum + safeNum(dRow[col]), 0);
            effectiveDispositions += EFFECTIVE_COLS.reduce((sum, col) => sum + safeNum(dRow[col]), 0);
        });

        const bruteConn = totalAvail > 0 ? totalDispositions / totalAvail : 0;
        const effectiveConn = totalAvail > 0 ? effectiveDispositions / totalAvail : 0;

        trends.push({
            hour,
            totalAvail: +totalAvail.toFixed(2),
            bruteConn: +bruteConn.toFixed(2),
            effectiveConn: +effectiveConn.toFixed(2),
        });
    }

    res.json({ date, trends });
});

// ── API: Get a cached snapshot for a specific hour ───────────
app.get('/api/snapshots/:hour', (req, res) => {
    const date = req.query.date || getTodayDateEDT();
    const hour = parseInt(req.params.hour);

    const snapshot = getSnapshot(date, hour);
    if (!snapshot) {
        return res.status(404).json({ error: `No cached data for ${date} hour ${hour}` });
    }

    res.json({
        stateCSV: snapshot.state_csv,
        dispoCSV: snapshot.dispo_csv,
        date,
        hour,
        cachedAt: snapshot.created_at,
    });
});

// ── Timezone helper: always use EDT (UTC-4) ─────────────────
function getNowEDT() {
    const now = new Date();
    // Shift UTC to EDT (UTC-4)
    const edt = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    return edt;
}

function getTodayDateEDT() {
    const edt = getNowEDT();
    return edt.toISOString().slice(0, 10);
}

// ── Cron: Auto-fetch PREVIOUS hour every hour ────────────────
// At 5:00 PM EDT we cache 4 PM (the hour that just finished, not the one starting)
cron.schedule('0 * * * *', async () => {
    const edt = getNowEDT();
    const currentHourEDT = edt.getUTCHours();
    const prevHour = currentHourEDT - 1;

    // Skip if previous hour is before midnight (no data for yesterday's 11 PM)
    if (prevHour < 0) return;

    const date = getTodayDateEDT();

    console.log(`\n⏰ Cron: Auto-fetching hour ${prevHour} for ${date} (EDT hour: ${currentHourEDT})`);

    try {
        const { stateCSV, dispoCSV } = await fetchHourlyReports(date, prevHour, prevHour);
        saveSnapshot(date, prevHour, stateCSV, dispoCSV);
        console.log(`⏰ Cron: Saved snapshot for ${date} hour ${prevHour}`);
    } catch (err) {
        console.error(`⏰ Cron: Failed for ${date} hour ${prevHour}:`, err.message);
    }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Five9 Report Dashboard running at http://localhost:${PORT}`);
    console.log(`   Reports folder: "${FIVE9_FOLDER}"`);
    console.log(`   State report:   "${FIVE9_STATE_REPORT}"`);
    console.log(`   Dispo report:   "${FIVE9_DISPO_REPORT}"`);
    console.log(`   ⏰ Hourly cron: active (every hour at :00)\n`);

    // Cleanup: remove any cached future-hour data from today
    const edt = getNowEDT();
    const currentHourEDT = edt.getUTCHours();
    const today = getTodayDateEDT();
    const result = deleteSnapshotsAfterHour(today, currentHourEDT - 1);
    if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} stale future-hour snapshot(s) for ${today}`);
    }
});
