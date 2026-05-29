/**
 * Web Screen-Time Tracker — Backend Server
 * ==========================================
 * Express server that collects screen-time data from the tracking snippet
 * and exposes a dashboard API. Uses SQLite for persistent storage.
 *
 * Endpoints:
 *   POST /api/screen-time   — Accept screen-time payloads (JSON or text/plain)
 *   GET  /api/dashboard     — Return aggregated screen-time data grouped by domain
 *
 * Run:
 *   npm install
 *   npm start       (or)   node server.js
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────

// Enable CORS for all origins (adjust in production)
app.use(cors());

// Parse JSON bodies (for standard fetch / axios requests)
app.use(express.json({ type: "application/json" }));

// Parse text/plain bodies (navigator.sendBeacon often sends text/plain)
app.use(express.text({ type: "text/plain" }));

// Serve static files from the project root (dashboard.html, tracker.js, etc.)
app.use(express.static(__dirname));

// Redirect root path to dashboard.html
app.get("/", (req, res) => {
  res.redirect("/dashboard.html");
});

// ─── SQLite Database Setup ──────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, "data.db");

let db;

try {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma("journal_mode = WAL");

  // Create the screen_time table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS screen_time (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      domain          TEXT    NOT NULL,
      path            TEXT    NOT NULL DEFAULT '/',
      durationSeconds INTEGER NOT NULL,
      timestamp       TEXT    NOT NULL,
      recovered       INTEGER NOT NULL DEFAULT 0,
      ingested_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Index on domain for faster aggregation queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_screen_time_domain ON screen_time(domain)`);

  console.log(`[db] SQLite database initialized at ${DB_PATH}`);
} catch (err) {
  console.error("[db] Failed to initialize SQLite database:", err);
  process.exit(1);
}

// ─── Database Helper Functions ──────────────────────────────────────────────

/**
 * Insert a screen-time log entry into storage.
 *
 * To migrate to PostgreSQL / MongoDB, change the implementation of this
 * function (and the two below) while keeping the same signature.
 *
 * @param {Object} entry - The screen-time payload
 * @returns {Promise<Object>} The inserted row with its generated id
 */
async function insertScreenTimeLog(entry) {
  const stmt = db.prepare(`
    INSERT INTO screen_time (domain, path, durationSeconds, timestamp, recovered)
    VALUES (@domain, @path, @durationSeconds, @timestamp, @recovered)
  `);

  const result = stmt.run({
    domain: entry.domain,
    path: entry.path,
    durationSeconds: entry.durationSeconds,
    timestamp: entry.timestamp,
    recovered: entry.recovered ? 1 : 0,
  });

  entry._id = result.lastInsertRowid;
  return entry;
}

/**
 * Retrieve all screen-time logs from storage.
 *
 * @returns {Promise<Array>} Array of log entries
 */
async function getAllScreenTimeLogs() {
  const rows = db.prepare(`
    SELECT id, domain, path, durationSeconds, timestamp, recovered, ingested_at
    FROM screen_time
    ORDER BY id DESC
  `).all();

  // Convert SQLite integer booleans back to JS booleans
  return rows.map((row) => ({
    ...row,
    recovered: row.recovered === 1,
  }));
}

/**
 * Aggregate screen-time logs grouped by domain, summing total active minutes.
 *
 * @returns {Promise<Array<{ domain: string, totalMinutes: number }>>}
 *          Sorted descending by totalMinutes.
 */
async function getAggregatedByDomain() {
  const rows = db.prepare(`
    SELECT
      domain,
      ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
    FROM screen_time
    GROUP BY domain
    ORDER BY totalMinutes DESC
  `).all();

  return rows.map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalMinutes,
  }));
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/screen-time
 *
 * Accepts screen-time payloads sent by the tracking snippet.
 * Handles both:
 *   - application/json (Content-Type: application/json)
 *   - text/plain (Content-Type: text/plain) — sent by navigator.sendBeacon
 *
 * Request body (JSON):
 *   { domain, path, durationSeconds, timestamp }
 *
 * Response: 201 { status: "ok", id }
 */
app.post("/api/screen-time", async (req, res) => {
  try {
    let payload = req.body;

    // If the body is a string (text/plain), parse it as JSON
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (parseErr) {
        return res.status(400).json({
          status: "error",
          message: "Invalid JSON in request body",
        });
      }
    }

    // Validate required fields
    if (!payload || !payload.domain || !payload.durationSeconds) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: domain, durationSeconds",
        received: payload,
      });
    }

    // Validate types
    if (typeof payload.durationSeconds !== "number" || payload.durationSeconds < 0) {
      return res.status(400).json({
        status: "error",
        message: "durationSeconds must be a non-negative number",
      });
    }

    // Validate duration is reasonable (max 1 hour per event — prevents abuse)
    if (payload.durationSeconds > 3600) {
      return res.status(400).json({
        status: "error",
        message: "durationSeconds exceeds maximum allowed (3600)",
      });
    }

    // Clean and normalize the entry
    const entry = {
      domain: String(payload.domain).toLowerCase().replace(/^www\./, ""),
      path: String(payload.path || "/"),
      durationSeconds: Math.round(payload.durationSeconds),
      timestamp: payload.timestamp || new Date().toISOString(),
      recovered: payload.recovered === true,
    };

    // Reject localhost — never store dashboard self-tracking data
    if (entry.domain === "localhost" || entry.domain === "127.0.0.1" || entry.domain === "") {
      return res.status(200).json({ status: "ignored", reason: "localhost" });
    }

    // Store the entry (via the DB helper)
    await insertScreenTimeLog(entry);

    console.log(
      `[screen-time] ${entry.domain}${entry.path} — ${entry.durationSeconds}s` +
        (entry.recovered ? " (recovered)" : "")
    );

    return res.status(201).json({
      status: "ok",
      id: entry._id,
    });
  } catch (err) {
    console.error("[screen-time] Error processing request:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

/**
 * GET /api/dashboard
 *
 * Returns aggregated screen-time data grouped by domain, sorted from
 * most-visited to least-visited, along with summary metrics.
 *
 * Response:
 * {
 *   totalDomains: number,
 *   totalMinutes: number,
 *   topDomain: string | null,
 *   domains: [ { domain, totalMinutes } ]
 * }
 */
app.get("/api/dashboard", async (req, res) => {
  try {
    const domains = await getAggregatedByDomain();

    const totalMinutes = domains.reduce((sum, d) => sum + d.totalMinutes, 0);
    const totalDomains = domains.length;
    const topDomain = domains.length > 0 ? domains[0].domain : null;

    return res.json({
      totalDomains,
      totalMinutes: Math.round(totalMinutes * 100) / 100,
      topDomain,
      domains,
    });
  } catch (err) {
    console.error("[dashboard] Error aggregating data:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

/**
 * GET /api/logs
 *
 * (Optional) Returns all raw logs for debugging / inspection.
 */
app.get("/api/logs", async (req, res) => {
  try {
    const logs = await getAllScreenTimeLogs();
    return res.json({ total: logs.length, logs });
  } catch (err) {
    console.error("[logs] Error fetching logs:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n[db] Closing database connection...");
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[db] Closing database connection...");
  db.close();
  process.exit(0);
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║     Web Screen-Time Tracker — Server Running     ║
╠══════════════════════════════════════════════════╣
║  POST  /api/screen-time   ← Collector           ║
║  GET   /api/dashboard     ← Dashboard API        ║
║  GET   /api/logs          ← Raw logs (debug)     ║
║                                                  ║
║  Listening on http://localhost:${String(PORT).padEnd(5)}              ║
╚══════════════════════════════════════════════════╝
  `);
});
