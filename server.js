/**
 * Web Screen-Time Tracker — Backend Server
 * ==========================================
 * Express server that collects screen-time data from the tracking snippet
 * and exposes a dashboard API.
 *
 * Supports TWO database backends:
 *   1. PostgreSQL  — when DATABASE_URL env var is set (production / Render)
 *   2. SQLite      — via sql.js (pure JS/WASM, zero native compilation — local dev)
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
 *   DATABASE_URL    — PostgreSQL connection string (if set, uses PostgreSQL)
 *   DATABASE_PATH   — SQLite database file path (default: ./data/screen-time.db)
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const USE_PG = !!process.env.DATABASE_URL;

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ type: "application/json" }));
app.use(express.text({ type: "text/plain" }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.redirect("/dashboard.html");
});

// ─── Database Abstraction ───────────────────────────────────────────────────
// Two drivers: PostgreSQL (production) and SQLite (local dev)
// Both expose the same async interface: { init, all, get, run, close }

const DATA_DIR = path.resolve(__dirname, "data");
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, "screen-time.db");
let driver = null;

// ─── SQLite Driver (sql.js — pure JS, no native compilation) ────────────────

async function createSqliteDriver() {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();

  let db;
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log(`[db] Loaded existing SQLite database from ${DB_PATH}`);
  } else {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new SQL.Database();
    console.log(`[db] Created new SQLite database at ${DB_PATH}`);
  }

  function save() {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  }

  return {
    isPostgres: false,

    init: async () => {
      db.run(sql_schema);
      save();
      console.log("[db] SQLite schema ready");
    },

    all(sql, params = []) {
      const stmt = db.prepare(sql);
      if (params.length > 0) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },

    get(sql, params = []) {
      const rows = this.all(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },

    run(sql, params = []) {
      const stmt = db.prepare(sql);
      if (params.length > 0) stmt.bind(params);
      stmt.step();
      stmt.free();
      const idRow = db.exec("SELECT last_insert_rowid() AS id");
      const chRow = db.exec("SELECT changes() AS n");
      save();
      return {
        lastInsertRowid: idRow?.[0]?.values?.[0]?.[0] ?? null,
        changes: chRow?.[0]?.values?.[0]?.[0] ?? 0,
      };
    },

    close() {
      save();
      console.log("[db] SQLite saved and closed");
    },
  };
}

// ─── PostgreSQL Driver ──────────────────────────────────────────────────────

async function createPostgresDriver(connectionString) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });

  // Test connection
  await pool.query("SELECT 1");

  // Convert ? placeholders to $1, $2, $3 ... for PostgreSQL
  const q = (sql, params = []) => {
    let idx = 0;
    const converted = sql.replace(/\?/g, () => `$${++idx}`);
    return pool.query(converted, params);
  };

  return {
    isPostgres: true,

    init: async () => {
      await pool.query(sql_schema_pg);

      // Migration: add user_id column if the table was created before multi-user support
      try {
        await pool.query(`ALTER TABLE screen_time ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`);
      } catch (_) { /* column may already exist — ignore */ }

      // Migration: ensure indexes exist for new columns
      try {
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id)`);
      } catch (_) { /* ignore */ }

      console.log("[db] PostgreSQL schema ready");
    },

    async all(sql, params = []) {
      const result = await q(sql, params);
      return result.rows;
    },

    async get(sql, params = []) {
      const rows = await this.all(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },

    async run(sql, params = []) {
      // For INSERT queries, append RETURNING id so we get the inserted row back
      const sqlToRun = sql.trim().toUpperCase().startsWith('INSERT')
        ? sql + ' RETURNING id'
        : sql;
      const result = await q(sqlToRun, params);
      return {
        lastInsertRowid: result.rows?.[0]?.id ?? null,
        changes: result.rowCount ?? 0,
      };
    },

    async close() {
      await pool.end();
      console.log("[db] PostgreSQL pool closed");
    },
  };
}

// ─── Schema SQL ─────────────────────────────────────────────────────────────

// Note: Double-quoted identifiers are needed for PostgreSQL case-sensitivity.
// SQLite accepts them too, so we use a single schema for both DDL.
const sql_schema = `
  CREATE TABLE IF NOT EXISTS screen_time (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL DEFAULT '',
    domain          TEXT NOT NULL,
    path            TEXT NOT NULL DEFAULT '/',
    durationSeconds REAL NOT NULL,
    timestamp       TEXT NOT NULL,
    recovered       INTEGER NOT NULL DEFAULT 0,
    ingested_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_screen_time_domain ON screen_time(domain);
  CREATE INDEX IF NOT EXISTS idx_screen_time_timestamp ON screen_time(timestamp);
  CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id);

  CREATE TABLE IF NOT EXISTS daily_goals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    domain        TEXT NOT NULL,
    max_minutes   REAL NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_daily_goals_domain ON daily_goals(domain);
`;

// PostgreSQL schema uses SERIAL instead of AUTOINCREMENT and BOOLEAN + NOW()
const sql_schema_pg = `
  CREATE TABLE IF NOT EXISTS screen_time (
    id              SERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL DEFAULT '',
    domain          TEXT NOT NULL,
    path            TEXT NOT NULL DEFAULT '/',
    durationSeconds DOUBLE PRECISION NOT NULL,
    timestamp       TIMESTAMP NOT NULL,
    recovered       BOOLEAN NOT NULL DEFAULT FALSE,
    ingested_at     TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_screen_time_domain ON screen_time(domain);
  CREATE INDEX IF NOT EXISTS idx_screen_time_timestamp ON screen_time(timestamp);
  CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id);

  CREATE TABLE IF NOT EXISTS daily_goals (
    id            SERIAL PRIMARY KEY,
    domain        TEXT NOT NULL,
    max_minutes   DOUBLE PRECISION NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_daily_goals_domain ON daily_goals(domain);
`;

// ─── Database Helper Functions ──────────────────────────────────────────────

/**
 * Insert a screen-time log entry into storage.
 */
async function insertScreenTimeLog(entry) {
  const result = await driver.run(
    `INSERT INTO screen_time (user_id, domain, path, durationSeconds, "timestamp", recovered)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.userId || '', entry.domain, entry.path, entry.durationSeconds, entry.timestamp, entry.recovered ? 1 : 0],
  );
  entry._id = result.lastInsertRowid;
  return entry;
}

/**
 * Retrieve all screen-time logs from storage.
 */
async function getAllScreenTimeLogs(userId) {
  const rows = await driver.all(
    `SELECT id, domain, path, durationSeconds, "timestamp", recovered, ingested_at
     FROM screen_time
     WHERE user_id = ?
     ORDER BY id DESC`,
    [userId || ''],
  );
  return rows.map((row) => ({
    ...row,
    recovered: row.recovered === 1 || row.recovered === true,
  }));
}

/**
 * Aggregate screen-time logs grouped by domain for a given date.
 */
async function getAggregatedByDomain(date, userId) {
  const dateValue = date || new Date().toISOString().slice(0, 10);
  const rows = await driver.all(
    `SELECT domain, ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE date("timestamp") = ? AND user_id = ?
     GROUP BY domain
     ORDER BY totalMinutes DESC`,
    [dateValue, userId || ''],
  );
  return rows.map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalMinutes || 0,
  }));
}

/**
 * Return all distinct dates that have screen-time data, sorted descending.
 */
async function getAvailableDates(userId) {
  const rows = await driver.all(
    `SELECT DISTINCT date("timestamp") AS d
     FROM screen_time
     WHERE user_id = ?
     ORDER BY d DESC`,
    [userId || ''],
  );
  return rows.map((row) => row.d);
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
async function getAggregatedByDomainForPeriod(startDate, endDate, userId) {
  const rows = await driver.all(
    `SELECT domain, ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE date("timestamp") >= ? AND date("timestamp") <= ? AND user_id = ?
     GROUP BY domain
     ORDER BY totalMinutes DESC`,
    [startDate, endDate, userId || ''],
  );
  return rows.map((row) => ({
    domain: row.domain,
    totalMinutes: row.totalMinutes || 0,
  }));
}

/**
 * Return total minutes per day for a date range.
 */
async function getDailyBreakdownForPeriod(startDate, endDate, userId) {
  const rows = await driver.all(
    `SELECT date("timestamp") AS d, ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE date("timestamp") >= ? AND date("timestamp") <= ? AND user_id = ?
     GROUP BY date("timestamp")
     ORDER BY d ASC`,
    [startDate, endDate, userId || ''],
  );
  return rows.map((row) => ({
    date: row.d,
    totalMinutes: row.totalMinutes || 0,
  }));
}

// ─── Daily Goals Helper Functions ───────────────────────────────────────────

/**
 * Get all daily goals.
 */
async function getGoals() {
  const rows = await driver.all(
    `SELECT id, domain, max_minutes, enabled, created_at, updated_at
     FROM daily_goals
     ORDER BY created_at DESC`,
  );
  return rows.map((row) => ({
    ...row,
    enabled: row.enabled === 1 || row.enabled === true,
    max_minutes: Number(row.max_minutes),
  }));
}

/**
 * Create a new daily goal.
 */
async function createGoal(domain, maxMinutes) {
  const result = await driver.run(
    `INSERT INTO daily_goals (domain, max_minutes) VALUES (?, ?)`,
    [domain.toLowerCase().replace(/^www\./, ""), maxMinutes],
  );
  return { id: result.lastInsertRowid };
}

/**
 * Update an existing daily goal.
 */
async function updateGoal(id, fields) {
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

  // Use correct "now" for each database
  const nowExpr = driver.isPostgres ? "NOW()" : "datetime('now')";
  sets.push(`updated_at = ${nowExpr}`);
  values.push(id);

  const result = await driver.run(
    `UPDATE daily_goals SET ${sets.join(", ")} WHERE id = ?`,
    values,
  );
  return { updated: result.changes > 0 };
}

/**
 * Delete a daily goal.
 */
async function deleteGoal(id) {
  const result = await driver.run("DELETE FROM daily_goals WHERE id = ?", [id]);
  return { deleted: result.changes > 0 };
}

/**
 * Get today's usage minutes for a specific domain.
 */
async function getTodayMinutesForDomain(domain, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await driver.get(
    `SELECT ROUND(SUM(durationSeconds) / 60.0, 2) AS totalMinutes
     FROM screen_time
     WHERE date("timestamp") = ? AND domain = ? AND user_id = ?`,
    [today, domain, userId || ''],
  );
  return (row && row.totalMinutes) || 0;
}

/**
 * Get goal status — compare today's usage against all enabled goals.
 */
async function getGoalStatus(userId) {
  const goals = await getGoals();
  const enabledGoals = goals.filter((g) => g.enabled);

  const result = [];
  for (const goal of enabledGoals) {
    const todayMinutes = await getTodayMinutesForDomain(goal.domain, userId);
    const percentage =
      goal.max_minutes > 0
        ? Math.min(Math.round((todayMinutes / goal.max_minutes) * 100), 999)
        : 0;

    result.push({
      id: goal.id,
      domain: goal.domain,
      maxMinutes: goal.max_minutes,
      todayMinutes,
      percentage,
      remainingMinutes: Math.max(0, goal.max_minutes - todayMinutes),
      exceeded: todayMinutes >= goal.max_minutes,
      approaching: percentage >= 80 && percentage < 100,
    });
  }
  return result;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/screen-time
 * Accepts screen-time payloads sent by the tracking snippet.
 */
app.post("/api/screen-time", async (req, res) => {
  try {
    let payload = req.body;

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

    const userToken = payload.userToken || req.headers['x-user-token'] || '';

    if (!payload || !payload.domain || !payload.durationSeconds) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: domain, durationSeconds",
        received: payload,
      });
    }

    if (typeof payload.durationSeconds !== "number" || payload.durationSeconds < 0) {
      return res.status(400).json({
        status: "error",
        message: "durationSeconds must be a non-negative number",
      });
    }

    if (payload.durationSeconds > 3600) {
      return res.status(400).json({
        status: "error",
        message: "durationSeconds exceeds maximum allowed (3600)",
      });
    }

    const entry = {
      userId: userToken,
      domain: String(payload.domain).toLowerCase().replace(/^www\./, ""),
      path: String(payload.path || "/"),
      durationSeconds: payload.durationSeconds,
      timestamp: payload.timestamp || new Date().toISOString(),
      recovered: payload.recovered === true,
    };

    if (entry.domain === "localhost" || entry.domain === "127.0.0.1" || entry.domain === "") {
      return res.status(200).json({ status: "ignored", reason: "localhost" });
    }

    await insertScreenTimeLog(entry);

    console.log(
      `[screen-time] ${entry.domain}${entry.path} — ${entry.durationSeconds}s` +
        (entry.recovered ? " (recovered)" : ""),
    );

    return res.status(201).json({ status: "ok", id: entry._id });
  } catch (err) {
    console.error("[screen-time] Error processing request:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/dashboard
 * Returns aggregated screen-time data grouped by domain for a given date.
 */
app.get("/api/dashboard", async (req, res) => {
  try {
    const requestedDate = req.query.date || null;

    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return res.status(400).json({ status: "error", message: "Invalid date format. Use YYYY-MM-DD." });
    }

    const userId = req.query.user || '';
    const domains = await getAggregatedByDomain(requestedDate, userId);
    const availableDates = await getAvailableDates(userId);

    const totalMinutes = domains.reduce((sum, d) => sum + d.totalMinutes, 0);
    const totalDomains = domains.length;
    const topDomain = domains.length > 0 ? domains[0].domain : null;

    const effectiveDate = requestedDate || new Date().toISOString().slice(0, 10);

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
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/summary
 * Returns aggregated screen-time data grouped by domain for a week or month period.
 */
app.get("/api/summary", async (req, res) => {
  try {
    const period = req.query.period || "week";
    const referenceDate = req.query.date || new Date().toISOString().slice(0, 10);

    if (!["week", "month"].includes(period)) {
      return res.status(400).json({ status: "error", message: "Invalid period. Use 'week' or 'month'." });
    }

    if (referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      return res.status(400).json({ status: "error", message: "Invalid date format. Use YYYY-MM-DD." });
    }

    const { start, end } = getPeriodRange(referenceDate, period);
    const userId = req.query.user || '';

    const domains = await getAggregatedByDomainForPeriod(start, end, userId);
    const dailyBreakdown = await getDailyBreakdownForPeriod(start, end, userId);
    const availableDates = await getAvailableDates(userId);

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
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ─── Goals Routes ───────────────────────────────────────────────────────────

app.get("/api/goals", async (req, res) => {
  try {
    const goals = await getGoals();
    return res.json({ goals });
  } catch (err) {
    console.error("[goals] Error fetching goals:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.post("/api/goals", async (req, res) => {
  try {
    const { domain, max_minutes } = req.body;

    if (!domain || !max_minutes) {
      return res.status(400).json({ status: "error", message: "Missing required fields: domain, max_minutes" });
    }

    if (typeof max_minutes !== "number" || max_minutes <= 0) {
      return res.status(400).json({ status: "error", message: "max_minutes must be a positive number" });
    }

    const result = await createGoal(domain, max_minutes);
    return res.status(201).json({ status: "ok", id: result.id });
  } catch (err) {
    console.error("[goals] Error creating goal:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.put("/api/goals/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid goal ID" });
    }

    const result = await updateGoal(id, req.body);
    if (!result.updated) {
      return res.status(404).json({ status: "error", message: "Goal not found" });
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("[goals] Error updating goal:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.delete("/api/goals/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid goal ID" });
    }

    const result = await deleteGoal(id);
    if (!result.deleted) {
      return res.status(404).json({ status: "error", message: "Goal not found" });
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("[goals] Error deleting goal:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.get("/api/goals/status", async (req, res) => {
  try {
    const userId = req.query.user || '';
    const statuses = await getGoalStatus(userId);
    return res.json({ goals: statuses });
  } catch (err) {
    console.error("[goals] Error getting goal status:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    const userId = req.query.user || '';
    const logs = await getAllScreenTimeLogs(userId);
    return res.json({ total: logs.length, logs });
  } catch (err) {
    console.error("[logs] Error fetching logs:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ─── Startup ────────────────────────────────────────────────────────────────

async function start() {
  if (USE_PG) {
    console.log("[db] DATABASE_URL detected — using PostgreSQL");
    driver = await createPostgresDriver(process.env.DATABASE_URL);
  } else {
    console.log("[db] No DATABASE_URL — using SQLite (sql.js)");
    driver = await createSqliteDriver();
  }

  await driver.init();
  console.log("[db] Database initialized successfully");

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
║  Database: ${USE_PG ? "PostgreSQL".padEnd(43) : "SQLite (sql.js)".padEnd(43)} ║
╚══════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\n[db] Shutting down...");
  if (driver) await driver.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[db] Shutting down...");
  if (driver) await driver.close();
  process.exit(0);
});
