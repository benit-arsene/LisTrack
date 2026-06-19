/**
 * Web Screen-Time Tracker — Backend Server
 * ==========================================
 * Express server that collects screen-time data from the tracking snippet
 * and exposes a dashboard API. Uses PostgreSQL for persistent storage.
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
 *   DATABASE_URL    — PostgreSQL connection string (required)
 *                    Example: postgres://user:pass@host:5432/listrack
 *   PORT            — HTTP server port (default: 3000)
 */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

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

// ─── PostgreSQL Database Setup ──────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("");
  console.error(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.error(
    "║  ERROR: DATABASE_URL environment variable is not set!       ║",
  );
  console.error(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.error(
    "║  To use this server, you must provide a PostgreSQL           ║",
  );
  console.error(
    "║  connection string via the DATABASE_URL environment var.     ║",
  );
  console.error(
    "║                                                              ║",
  );
  console.error(
    "║  Example:                                                     ║",
  );
  console.error(
    "║    DATABASE_URL=postgres://user:pass@host:5432/listrack       ║",
  );
  console.error(
    "║                                                              ║",
  );
  console.error(
    "║  On Render: Create a PostgreSQL database in your dashboard    ║",
  );
  console.error(
    "║  and it will auto-inject the DATABASE_URL env var.           ║",
  );
  console.error(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.error("");
  process.exit(1);
}

// Create a connection pool using the DATABASE_URL
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Allow Render to enforce SSL (required by Render PostgreSQL)
  ssl: {
    rejectUnauthorized: false,
  },
  // Connection pool settings
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test the database connection and create tables on startup
async function initializeDatabase() {
  try {
    // Test the connection
    const client = await pool.connect();
    console.log("[db] Connected to PostgreSQL successfully");

    // Create the screen_time table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS screen_time (
        id              SERIAL PRIMARY KEY,
        domain          TEXT NOT NULL,
        path            TEXT NOT NULL DEFAULT '/',
        "durationSeconds" DOUBLE PRECISION NOT NULL,
        "timestamp"     TEXT NOT NULL,
        recovered       BOOLEAN NOT NULL DEFAULT FALSE,
        ingested_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // Index on domain for faster aggregation queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_screen_time_domain
      ON screen_time(domain)
    `);

    // Create the daily_goals table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_goals (
        id          SERIAL PRIMARY KEY,
        domain      TEXT NOT NULL,
        max_minutes DOUBLE PRECISION NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // Index on domain for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_goals_domain
      ON daily_goals(domain)
    `);

    client.release();
    console.log("[db] Database tables initialized successfully");
  } catch (err) {
    console.error("[db] Failed to initialize PostgreSQL database:", err);
    process.exit(1);
  }
}

// Run database initialization, then start the server
initializeDatabase().then(() => {
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
});

// ─── Database Helper Functions ──────────────────────────────────────────────

/**
 * Insert a screen-time log entry into storage.
 *
 * @param {Object} entry - The screen-time payload
 * @returns {Promise<Object>} The inserted row with its generated id
 */
async function insertScreenTimeLog(entry) {
  const result = await pool.query(
    `INSERT INTO screen_time (domain, path, "durationSeconds", "timestamp", recovered)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      entry.domain,
      entry.path,
      entry.durationSeconds,
      entry.timestamp,
      entry.recovered,
    ],
  );

  entry._id = result.rows[0].id;
  return entry;
}

/**
 * Retrieve all screen-time logs from storage.
 *
 * @returns {Promise<Array>} Array of log entries
 */
async function getAllScreenTimeLogs() {
  const result = await pool.query(`
    SELECT id, domain, path, "durationSeconds", "timestamp", recovered, ingested_at
    FROM screen_time
    ORDER BY id DESC
  `);

  // recovered is already a boolean from PostgreSQL
  return result.rows.map((row) => ({
    ...row,
    recovered: row.recovered,
  }));
}

/**
 * Aggregate screen-time logs grouped by domain, summing total active minutes.
 * Only includes entries from today (resets at midnight) so the dashboard shows
 * daily screen time instead of an ever-growing cumulative total.
 *
 * @param {string} [date] - Optional date string in YYYY-MM-DD format. Defaults to today.
 * @returns {Promise<Array<{ domain: string, totalMinutes: number }>>}
 *          Sorted descending by totalMinutes.
 */
async function getAggregatedByDomain(date) {
  // Default to today's UTC date so the query is always parameterized
  const dateValue = date || new Date().toISOString().slice(0, 10);

  const result = await pool.query(
    `SELECT
       domain,
       ROUND(SUM("durationSeconds") / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE DATE("timestamp") = $1
     GROUP BY domain
     ORDER BY totalMinutes DESC`,
    [dateValue],
  );

  return result.rows.map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalminutes || 0,
  }));
}

/**
 * Return all distinct dates that have screen-time data, sorted descending.
 *
 * @returns {Promise<string[]>} Array of date strings in YYYY-MM-DD format.
 */
async function getAvailableDates() {
  const result = await pool.query(`
    SELECT DISTINCT DATE("timestamp") AS d
    FROM screen_time
    ORDER BY d DESC
  `);

  return result.rows.map((row) => row.d);
}

/**
 * Calculate the start and end date of a period (week or month) containing
 * the given reference date.
 *
 * @param {string} dateStr - Reference date in YYYY-MM-DD format.
 * @param {'week'|'month'} period - The period type.
 * @returns {{ start: string, end: string }} ISO date strings.
 */
function getPeriodRange(dateStr, period) {
  const d = new Date(dateStr + "T00:00:00Z");

  if (period === "week") {
    // Monday-first weeks: Monday=1, Sunday=0 → treat Sunday as 7
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

  // Fallback — single date
  return { start: dateStr, end: dateStr };
}

/**
 * Aggregate screen-time logs grouped by domain for a date range.
 *
 * @param {string} startDate - Start date YYYY-MM-DD (inclusive).
 * @param {string} endDate   - End date YYYY-MM-DD (inclusive).
 * @returns {Promise<Array<{ domain: string, totalMinutes: number }>>}
 */
async function getAggregatedByDomainForPeriod(startDate, endDate) {
  const result = await pool.query(
    `SELECT
       domain,
       ROUND(SUM("durationSeconds") / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE DATE("timestamp") >= $1 AND DATE("timestamp") <= $2
     GROUP BY domain
     ORDER BY totalMinutes DESC`,
    [startDate, endDate],
  );

  return result.rows.map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalminutes || 0,
  }));
}

/**
 * Return total minutes per day for a date range — used for the daily breakdown chart.
 *
 * @param {string} startDate - Start date YYYY-MM-DD (inclusive).
 * @param {string} endDate   - End date YYYY-MM-DD (inclusive).
 * @returns {Promise<Array<{ date: string, totalMinutes: number }>>}
 */
async function getDailyBreakdownForPeriod(startDate, endDate) {
  const result = await pool.query(
    `SELECT
       DATE("timestamp") AS d,
       ROUND(SUM("durationSeconds") / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE DATE("timestamp") >= $1 AND DATE("timestamp") <= $2
     GROUP BY DATE("timestamp")
     ORDER BY d ASC`,
    [startDate, endDate],
  );

  return result.rows.map((row) => ({
    date: row.d,
    totalMinutes: row.totalminutes || 0,
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
    if (
      typeof payload.durationSeconds !== "number" ||
      payload.durationSeconds < 0
    ) {
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

    // Store the entry (via the DB helper)
    await insertScreenTimeLog(entry);

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
 * Returns aggregated screen-time data grouped by domain for a given date,
 * sorted from most-visited to least-visited, along with summary metrics.
 *
 * Query params:
 *   date — Optional. YYYY-MM-DD format. Defaults to today (UTC).
 *
 * Response:
 * {
 *   date: string,            // The date being viewed (YYYY-MM-DD)
 *   totalDomains: number,
 *   totalMinutes: number,
 *   topDomain: string | null,
 *   domains: [ { domain, totalMinutes } ],
 *   availableDates: string[] // All dates that have data
 * }
 */
app.get("/api/dashboard", async (req, res) => {
  try {
    const requestedDate = req.query.date || null;

    // Validate date format if provided
    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid date format. Use YYYY-MM-DD.",
      });
    }

    const [domains, availableDates] = await Promise.all([
      getAggregatedByDomain(requestedDate),
      getAvailableDates(),
    ]);

    const totalMinutes = domains.reduce((sum, d) => sum + d.totalMinutes, 0);
    const totalDomains = domains.length;
    const topDomain = domains.length > 0 ? domains[0].domain : null;

    // Determine the effective date being viewed
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
 *
 * Response:
 * {
 *   period: string,
 *   startDate: string,       // Period start (inclusive)
 *   endDate: string,         // Period end (inclusive)
 *   totalDomains: number,
 *   totalMinutes: number,
 *   topDomain: string | null,
 *   domains: [ { domain, totalMinutes } ],
 *   dailyBreakdown: [ { date, totalMinutes } ],
 *   availableDates: string[]
 * }
 */
app.get("/api/summary", async (req, res) => {
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

    const [domains, dailyBreakdown, availableDates] = await Promise.all([
      getAggregatedByDomainForPeriod(start, end),
      getDailyBreakdownForPeriod(start, end),
      getAvailableDates(),
    ]);

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
 *
 * Returns all daily goals.
 */
app.get("/api/goals", async (req, res) => {
  try {
    const goals = await getGoals();
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
 *
 * Create a new daily goal.
 * Body: { domain: string, max_minutes: number }
 */
app.post("/api/goals", async (req, res) => {
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

    const result = await createGoal(domain, max_minutes);
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
 *
 * Update an existing daily goal.
 * Body: { domain?: string, max_minutes?: number, enabled?: boolean }
 */
app.put("/api/goals/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid goal ID" });
    }

    const result = await updateGoal(id, req.body);
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
 *
 * Delete a daily goal.
 */
app.delete("/api/goals/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid goal ID" });
    }

    const result = await deleteGoal(id);
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
 * Used by the background service worker and dashboard.
 */
app.get("/api/goals/status", async (req, res) => {
  try {
    const statuses = await getGoalStatus();
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
 * (Optional) Returns all raw logs for debugging / inspection.
 */
app.get("/api/logs", async (req, res) => {
  try {
    const logs = await getAllScreenTimeLogs();
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
async function getGoals() {
  const result = await pool.query(`
    SELECT id, domain, max_minutes, enabled, created_at, updated_at
    FROM daily_goals
    ORDER BY created_at DESC
  `);

  // enabled is already a boolean from PostgreSQL
  return result.rows.map((row) => ({
    ...row,
    enabled: row.enabled,
  }));
}

/**
 * Create a new daily goal.
 */
async function createGoal(domain, maxMinutes) {
  const result = await pool.query(
    `INSERT INTO daily_goals (domain, max_minutes)
     VALUES ($1, $2)
     RETURNING id`,
    [domain.toLowerCase().replace(/^www\./, ""), maxMinutes],
  );

  return { id: result.rows[0].id };
}

/**
 * Update an existing daily goal.
 */
async function updateGoal(id, fields) {
  const sets = [];
  const values = [];
  let paramIndex = 1;

  if (fields.domain !== undefined) {
    sets.push(`domain = $${paramIndex++}`);
    values.push(fields.domain.toLowerCase().replace(/^www\./, ""));
  }
  if (fields.max_minutes !== undefined) {
    sets.push(`max_minutes = $${paramIndex++}`);
    values.push(fields.max_minutes);
  }
  if (fields.enabled !== undefined) {
    sets.push(`enabled = $${paramIndex++}`);
    values.push(fields.enabled);
  }

  if (sets.length === 0) return { updated: false };

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE daily_goals SET ${sets.join(", ")} WHERE id = $${paramIndex}`,
    values,
  );

  return { updated: result.rowCount > 0 };
}

/**
 * Delete a daily goal.
 */
async function deleteGoal(id) {
  const result = await pool.query(`DELETE FROM daily_goals WHERE id = $1`, [
    id,
  ]);

  return { deleted: result.rowCount > 0 };
}

/**
 * Get today's usage minutes for a specific domain (used by the status endpoint).
 */
async function getTodayMinutesForDomain(domain) {
  const today = new Date().toISOString().slice(0, 10);

  const result = await pool.query(
    `SELECT ROUND(SUM("durationSeconds") / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE DATE("timestamp") = $1 AND domain = $2`,
    [today, domain],
  );

  return result.rows[0] ? result.rows[0].totalminutes || 0 : 0;
}

/**
 * Get goal status — compare today's usage against all enabled goals.
 * Returns each goal with its current usage, limit, and percentage.
 */
async function getGoalStatus() {
  const goals = await getGoals();
  const enabledGoals = goals.filter((g) => g.enabled);

  const statuses = await Promise.all(
    enabledGoals.map(async (goal) => {
      const todayMinutes = await getTodayMinutesForDomain(goal.domain);
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
    }),
  );

  return statuses;
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\n[db] Closing database connections...");
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[db] Closing database connections...");
  await pool.end();
  process.exit(0);
});
