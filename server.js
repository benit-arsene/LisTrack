/**
 * Web Screen-Time Tracker — Backend Server
 * ==========================================
 * Express server that collects screen-time data from the tracking snippet
 * and exposes a dashboard API. Uses SQLite for persistent storage so it
 * runs with zero configuration — no external database needed.
 *
 * Endpoints:
 *   POST /api/screen-time   — Accept screen-time payloads (JSON or text/plain)
 *   GET  /api/dashboard     — Return aggregated screen-time data grouped by domain
 *
 * Run:
 *   npm install
 *   npm start       (or)   node server.js
 *
 * Environment:
 *   PORT            — HTTP server port (default: 3000)
 *   DATABASE_PATH   — Path to SQLite database file (default: ./data/screen-time.db)
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────

// Enable CORS for all origins
app.use(cors());

// Parse JSON bodies
app.use(express.json({ type: "application/json" }));

// Parse text/plain bodies (navigator.sendBeacon often sends text/plain)
app.use(express.text({ type: "text/plain" }));

// Serve static files from the project root
app.use(express.static(__dirname));

// Redirect root path to dashboard.html
app.get("/", (req, res) => {
  res.redirect("/dashboard.html");
});

// ─── SQLite Database Setup ──────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, "data");
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, "screen-time.db");

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS screen_time (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL DEFAULT '',
    domain          TEXT NOT NULL,
    path            TEXT NOT NULL DEFAULT '/',
    durationSeconds REAL NOT NULL,
    timestamp       TEXT NOT NULL,
    recovered       INTEGER NOT NULL DEFAULT 0,
    ingested_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_screen_time_domain
  ON screen_time(domain)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_screen_time_timestamp
  ON screen_time(timestamp)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_screen_time_user
  ON screen_time(user_id)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    domain      TEXT NOT NULL,
    max_minutes REAL NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_daily_goals_domain
  ON daily_goals(domain)
`);

console.log(`[db] SQLite database opened at ${DB_PATH}`);

// ─── Database Helper Functions ──────────────────────────────────────────────

/**
 * Insert a screen-time log entry into storage.
 */
function insertScreenTimeLog(entry) {
  const stmt = db.prepare(`
    INSERT INTO screen_time (user_id, domain, path, durationSeconds, timestamp, recovered)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    entry.userId || '',
    entry.domain,
    entry.path,
    entry.durationSeconds,
    entry.timestamp,
    entry.recovered ? 1 : 0,
  );
  entry._id = result.lastInsertRowid;
  return entry;
}

/**
 * Retrieve all screen-time logs from storage.
 */
function getAllScreenTimeLogs(userId) {
  const stmt = db.prepare(`
    SELECT id, domain, path, durationSeconds, timestamp, recovered, ingested_at
    FROM screen_time
    WHERE user_id = ?
    ORDER BY id DESC
  `);
  return stmt.all(userId || '').map((row) => ({
    ...row,
    recovered: row.recovered === 1,
  }));
}

/**
 * Aggregate screen-time logs grouped by domain for a given date.
 */
function getAggregatedByDomain(date, userId) {
  const dateValue = date || new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(`
    SELECT
      domain,
      ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
    FROM screen_time
    WHERE date(timestamp) = ? AND user_id = ?
    GROUP BY domain
    ORDER BY totalMinutes DESC
  `);
  return stmt.all(dateValue, userId || '').map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalMinutes || 0,
  }));
}

/**
 * Return all distinct dates that have screen-time data, sorted descending.
 */
function getAvailableDates(userId) {
  const stmt = db.prepare(`
    SELECT DISTINCT date(timestamp) AS d
    FROM screen_time
    WHERE user_id = ?
    ORDER BY d DESC
  `);
  return stmt.all(userId || '').map((row) => row.d);
}

/**
 * Calculate the start and end date of a period (week or month) containing
 * the given reference date.
 */
function getPeriodRange(dateStr, period) {
  const d = new Date(dateStr + "T00:00:00Z");

  if (period === "week") {
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() + diff);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }

  if (period === "month") {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }

  return { start: dateStr, end: dateStr };
}

/**
 * Aggregate screen-time logs grouped by domain for a date range.
 */
function getAggregatedByDomainForPeriod(startDate, endDate, userId) {
  const stmt = db.prepare(`
    SELECT
      domain,
      ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
    FROM screen_time
    WHERE date(timestamp) >= ? AND date(timestamp) <= ? AND user_id = ?
    GROUP BY domain
    ORDER BY totalMinutes DESC
  `);
  return stmt.all(startDate, endDate, userId || '').map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalMinutes || 0,
  }));
}

/**
 * Return total minutes per day for a date range.
 */
function getDailyBreakdownForPeriod(startDate, endDate, userId) {
  const stmt = db.prepare(`
    SELECT
      date(timestamp) AS d,
      ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
    FROM screen_time
    WHERE date(timestamp) >= ? AND date(timestamp) <= ? AND user_id = ?
    GROUP BY date(timestamp)
    ORDER BY d ASC
  `);
  return stmt.all(startDate, endDate, userId || '').map((row) => ({
    date: row.d,
    totalMinutes: row.totalMinutes || 0,
  }));
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/screen-time
 *
 * Accepts screen-time payloads sent by the tracking snippet.
 */
app.post("/api/screen-time", (req, res) => {
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

    // Extract user token (from body or header)
    const userToken = payload.userToken || req.headers['x-user-token'] || '';

    // Validate required fields
    if (!payload || !payload.domain || !payload.durationSeconds) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: domain, durationSeconds",
        received: payload,
      });
    }

    // Validate types
    if (
      typeof payload.durationSeconds !== "number" ||
      payload.durationSeconds < 0
    ) {
      return res.status(400).json({
        status: "error",
        message: "durationSeconds must be a non-negative number",
      });
    }

    // Validate duration is reasonable (max 1 hour per event)
    if (payload.durationSeconds > 3600) {
      return res.status(400).json({
        status: "error",
        message: "durationSeconds exceeds maximum allowed (3600)",
      });
    }

    // Clean and normalize the entry
    const entry = {
      userId: userToken,
      domain: String(payload.domain)
        .toLowerCase()
        .replace(/^www\./, ""),
      path: String(payload.path || "/"),
      durationSeconds: payload.durationSeconds,
      timestamp: payload.timestamp || new Date().toISOString(),
      recovered: payload.recovered === true,
    };

    // Reject localhost — never store dashboard self-tracking data
    if (
      entry.domain === "localhost" ||
      entry.domain === "127.0.0.1" ||
      entry.domain === ""
    ) {
      return res.status(200).json({ status: "ignored", reason: "localhost" });
    }

    // Store the entry
    insertScreenTimeLog(entry);

    console.log(
      `[screen-time] ${entry.domain}${entry.path} — ${entry.durationSeconds}s` +
        (entry.recovered ? " (recovered)" : ""),
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
 * Returns aggregated screen-time data grouped by domain for a given date.
 *
 * Query params:
 *   date — Optional. YYYY-MM-DD format. Defaults to today (UTC).
 *   user — Optional. User token for multi-user isolation. Defaults to ''.
 */
app.get("/api/dashboard", (req, res) => {
  try {
    const requestedDate = req.query.date || null;

    // Validate date format if provided
    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid date format. Use YYYY-MM-DD.",
      });
    }

    const userId = req.query.user || '';

    const domains = getAggregatedByDomain(requestedDate, userId);
    const availableDates = getAvailableDates(userId);

    const totalMinutes = domains.reduce((sum, d) => sum + d.totalMinutes, 0);
    const totalDomains = domains.length;
    const topDomain = domains.length > 0 ? domains[0].domain : null;

    const effectiveDate =
      requestedDate || new Date().toISOString().slice(0, 10);

    return res.json({
      date: effectiveDate,
      totalDomains,
      totalMinutes: Math.round(totalMinutes * 100) / 100,
      topDomain,
      domains,
      availableDates,
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
 * GET /api/summary
 *
 * Returns aggregated screen-time data grouped by domain for a week or month
 * period, along with a daily breakdown for that period.
 *
 * Query params:
 *   period — 'week' or 'month'. Defaults to 'week'.
 *   date   — Reference date YYYY-MM-DD. Defaults to today (UTC).
 *   user   — Optional. User token for multi-user isolation.
 */
app.get("/api/summary", (req, res) => {
  try {
    const period = req.query.period || "week";
    const referenceDate =
      req.query.date || new Date().toISOString().slice(0, 10);

    if (!["week", "month"].includes(period)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid period. Use 'week' or 'month'.",
      });
    }

    if (referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid date format. Use YYYY-MM-DD.",
      });
    }

    const { start, end } = getPeriodRange(referenceDate, period);
    const userId = req.query.user || '';

    const domains = getAggregatedByDomainForPeriod(start, end, userId);
    const dailyBreakdown = getDailyBreakdownForPeriod(start, end, userId);
    const availableDates = getAvailableDates(userId);

    const totalMinutes = domains.reduce((sum, d) => sum + d.totalMinutes, 0);
    const totalDomains = domains.length;
    const topDomain = domains.length > 0 ? domains[0].domain : null;

    return res.json({
      period,
      startDate: start,
      endDate: end,
      totalDomains,
      totalMinutes: Math.round(totalMinutes * 100) / 100,
      topDomain,
      domains,
      dailyBreakdown,
      availableDates,
    });
  } catch (err) {
    console.error("[summary] Error aggregating data:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

// ─── Goals Routes ───────────────────────────────────────────────────────────

/**
 * GET /api/goals
 */
app.get("/api/goals", (req, res) => {
  try {
    const goals = getGoals();
    return res.json({ goals });
  } catch (err) {
    console.error("[goals] Error fetching goals:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * POST /api/goals
 * Body: { domain: string, max_minutes: number }
 */
app.post("/api/goals", (req, res) => {
  try {
    const { domain, max_minutes } = req.body;

    if (!domain || !max_minutes) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: domain, max_minutes",
      });
    }

    if (typeof max_minutes !== "number" || max_minutes <= 0) {
      return res.status(400).json({
        status: "error",
        message: "max_minutes must be a positive number",
      });
    }

    const result = createGoal(domain, max_minutes);
    return res.status(201).json({ status: "ok", id: result.id });
  } catch (err) {
    console.error("[goals] Error creating goal:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * PUT /api/goals/:id
 * Body: { domain?: string, max_minutes?: number, enabled?: boolean }
 */
app.put("/api/goals/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid goal ID" });
    }

    const result = updateGoal(id, req.body);
    if (!result.updated) {
      return res
        .status(404)
        .json({ status: "error", message: "Goal not found" });
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("[goals] Error updating goal:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * DELETE /api/goals/:id
 */
app.delete("/api/goals/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid goal ID" });
    }

    const result = deleteGoal(id);
    if (!result.deleted) {
      return res
        .status(404)
        .json({ status: "error", message: "Goal not found" });
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("[goals] Error deleting goal:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/goals/status
 *
 * Returns today's usage compared against all enabled goals.
 */
app.get("/api/goals/status", (req, res) => {
  try {
    const userId = req.query.user || '';
    const statuses = getGoalStatus(userId);
    return res.json({ goals: statuses });
  } catch (err) {
    console.error("[goals] Error getting goal status:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/logs
 *
 * Returns all raw logs for debugging / inspection.
 */
app.get("/api/logs", (req, res) => {
  try {
    const userId = req.query.user || '';
    const logs = getAllScreenTimeLogs(userId);
    return res.json({ total: logs.length, logs });
  } catch (err) {
    console.error("[logs] Error fetching logs:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

// ─── Daily Goals Helper Functions ───────────────────────────────────────────

/**
 * Get all daily goals.
 */
function getGoals() {
  const stmt = db.prepare(`
    SELECT id, domain, max_minutes, enabled, created_at, updated_at
    FROM daily_goals
    ORDER BY created_at DESC
  `);
  return stmt.all().map((row) => ({
    ...row,
    enabled: row.enabled === 1,
  }));
}

/**
 * Create a new daily goal.
 */
function createGoal(domain, maxMinutes) {
  const stmt = db.prepare(`
    INSERT INTO daily_goals (domain, max_minutes)
    VALUES (?, ?)
  `);
  const result = stmt.run(domain.toLowerCase().replace(/^www\./, ""), maxMinutes);
  return { id: result.lastInsertRowid };
}

/**
 * Update an existing daily goal.
 */
function updateGoal(id, fields) {
  const sets = [];
  const values = [];

  if (fields.domain !== undefined) {
    sets.push("domain = ?");
    values.push(fields.domain.toLowerCase().replace(/^www\./, ""));
  }
  if (fields.max_minutes !== undefined) {
    sets.push("max_minutes = ?");
    values.push(fields.max_minutes);
  }
  if (fields.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(fields.enabled ? 1 : 0);
  }

  if (sets.length === 0) return { updated: false };

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const stmt = db.prepare(`UPDATE daily_goals SET ${sets.join(", ")} WHERE id = ?`);
  const result = stmt.run(...values);
  return { updated: result.changes > 0 };
}

/**
 * Delete a daily goal.
 */
function deleteGoal(id) {
  const stmt = db.prepare("DELETE FROM daily_goals WHERE id = ?");
  const result = stmt.run(id);
  return { deleted: result.changes > 0 };
}

/**
 * Get today's usage minutes for a specific domain.
 */
function getTodayMinutesForDomain(domain, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(`
    SELECT ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
    FROM screen_time
    WHERE date(timestamp) = ? AND domain = ? AND user_id = ?
  `);
  const row = stmt.get(today, domain, userId || '');
  return row.totalMinutes || 0;
}

/**
 * Get goal status — compare today's usage against all enabled goals.
 */
function getGoalStatus(userId) {
  const goals = getGoals();
  const enabledGoals = goals.filter((g) => g.enabled);

  return enabledGoals.map((goal) => {
    const todayMinutes = getTodayMinutesForDomain(goal.domain, userId);
    const percentage =
      goal.max_minutes > 0
        ? Math.min(Math.round((todayMinutes / goal.max_minutes) * 100), 999)
        : 0;

    return {
      id: goal.id,
      domain: goal.domain,
      maxMinutes: goal.max_minutes,
      todayMinutes,
      percentage,
      remainingMinutes: Math.max(0, goal.max_minutes - todayMinutes),
      exceeded: todayMinutes >= goal.max_minutes,
      approaching: percentage >= 80 && percentage < 100,
    };
  });
}

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
║  Database: SQLite (./data/screen-time.db)        ║
╚══════════════════════════════════════════════════╝
  `);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n[db] Closing database...");
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[db] Closing database...");
  db.close();
  process.exit(0);
});
