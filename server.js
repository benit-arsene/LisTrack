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

// Redirect old /dashboard.html links to clean /dashboard (preserves query params like ?user=TOKEN)
app.use((req, res, next) => {
  if (req.path === "/dashboard.html") {
    const query = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
    return res.redirect(301, "/dashboard" + query);
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// Serve dashboard at the clean /dashboard URL
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "html", "dashboard.html"));
});

// Root route — serve index.html from public/html/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "html", "index.html"));
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

      // Migration: add user_id column if the table was created before multi-user support
      try {
        const tableInfo = db.exec("PRAGMA table_info('screen_time')");
        const columns = tableInfo[0]?.values?.map(v => v[1]) || [];
        if (!columns.includes('user_id')) {
          db.run("ALTER TABLE screen_time ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
          console.log('[db] SQLite migration: added user_id column to screen_time');
        }
      } catch (err) {
        console.error('[db] SQLite migration error:', err.message);
      }

      // Migration: add user_id column to daily_goals
      try {
        const goalsInfo = db.exec("PRAGMA table_info('daily_goals')");
        const goalCols = goalsInfo[0]?.values?.map(v => v[1]) || [];
        if (!goalCols.includes('user_id')) {
          db.run("ALTER TABLE daily_goals ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
          console.log('[db] SQLite migration: added user_id column to daily_goals');
        }
        // Create index on user_id (safe to run even if column already existed)
        db.run("CREATE INDEX IF NOT EXISTS idx_daily_goals_user ON daily_goals(user_id)");
      } catch (err) {
        console.error('[db] SQLite migration error (daily_goals):', err.message);
      }

      // Clean up old global goals (user_id is empty — created before per-user goals)
      try {
        db.run("DELETE FROM daily_goals WHERE user_id = ''");
      } catch (_) {}

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
        const colResult = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'screen_time' AND column_name = 'user_id'
        `);
        if (colResult.rows.length === 0) {
          await pool.query(`ALTER TABLE screen_time ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
          console.log('[db] PostgreSQL migration: added user_id column');
        }
      } catch (err) {
        console.error('[db] PostgreSQL migration error:', err.message);
      }

      // Migration: ensure indexes exist for new columns
      try {
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id)`);
      } catch (err) {
        console.error('[db] PostgreSQL index migration error:', err.message);
      }

      // Migration: add user_id column to daily_goals
      try {
        const colResult = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'daily_goals' AND column_name = 'user_id'
        `);
        if (colResult.rows.length === 0) {
          await pool.query(`ALTER TABLE daily_goals ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
          console.log('[db] PostgreSQL migration: added user_id column to daily_goals');
        }
        // Create index on user_id (safe to run even if column already existed)
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_goals_user ON daily_goals(user_id)`);
      } catch (err) {
        console.error('[db] PostgreSQL migration error (daily_goals):', err.message);
      }

      // Clean up old global goals
      try {
        await pool.query(`DELETE FROM daily_goals WHERE user_id = ''`);
      } catch (_) {}

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
    user_id       TEXT NOT NULL DEFAULT '',
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
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    timestamp       TIMESTAMP NOT NULL,
    recovered       BOOLEAN NOT NULL DEFAULT FALSE,
    ingested_at     TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_screen_time_domain ON screen_time(domain);
  CREATE INDEX IF NOT EXISTS idx_screen_time_timestamp ON screen_time(timestamp);
  CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id);

  CREATE TABLE IF NOT EXISTS daily_goals (
    id            SERIAL PRIMARY KEY,
    user_id       TEXT NOT NULL DEFAULT '',
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
    `INSERT INTO screen_time (user_id, domain, path, "durationSeconds", "timestamp", recovered)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.userId || '', entry.domain, entry.path, entry.durationSeconds, entry.timestamp, driver.isPostgres ? !!entry.recovered : (entry.recovered ? 1 : 0)],
  );
  entry._id = result.lastInsertRowid;
  return entry;
}

/**
 * Retrieve all screen-time logs from storage.
 */
async function getAllScreenTimeLogs(userId) {
  const rows = await driver.all(
    `SELECT id, domain, path, "durationSeconds", "timestamp", recovered, ingested_at
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
    `SELECT domain, ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 2) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") = ? AND user_id = ?
     GROUP BY domain
     ORDER BY "totalMinutes" DESC`,
    [dateValue, userId || ''],
  );
  return rows.map((row) => ({
    domain: row.domain,
    totalMinutes: Number(row.totalMinutes) || 0,
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

  if (period === "7days") {
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() - 6);
    return {
      start: start.toISOString().slice(0, 10),
      end: dateStr,
    };
  }

  if (period === "30days") {
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() - 29);
    return {
      start: start.toISOString().slice(0, 10),
      end: dateStr,
    };
  }

  return { start: dateStr, end: dateStr };
}

/**
 * Aggregate screen-time logs grouped by domain for a date range.
 */
async function getAggregatedByDomainForPeriod(startDate, endDate, userId) {
  const rows = await driver.all(
    `SELECT domain, ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 2) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") >= ? AND date("timestamp") <= ? AND user_id = ?
     GROUP BY domain
     ORDER BY "totalMinutes" DESC`,
    [startDate, endDate, userId || ''],
  );
  return rows.map((row) => ({
    domain: row.domain,
    totalMinutes: Number(row.totalMinutes) || 0,
  }));
}

/**
 * Return total minutes per day for a date range.
 */
async function getDailyBreakdownForPeriod(startDate, endDate, userId) {
  const rows = await driver.all(
    `SELECT date("timestamp") AS d, ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 2) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") >= ? AND date("timestamp") <= ? AND user_id = ?
     GROUP BY date("timestamp")
     ORDER BY d ASC`,
    [startDate, endDate, userId || ''],
  );
  return rows.map((row) => ({
    date: row.d,
    totalMinutes: Number(row.totalMinutes) || 0,
  }));
}

// ─── Daily Goals Helper Functions ───────────────────────────────────────────

/**
 * Get daily goals for a specific user.
 */
async function getGoals(userId) {
  if (!userId) return [];
  const rows = await driver.all(
    `SELECT id, user_id, domain, max_minutes, enabled, created_at, updated_at
     FROM daily_goals
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    ...row,
    enabled: row.enabled === 1 || row.enabled === true,
    max_minutes: Number(row.max_minutes),
  }));
}

/**
 * Create a new daily goal for a specific user.
 */
async function createGoal(domain, maxMinutes, userId) {
  const result = await driver.run(
    `INSERT INTO daily_goals (user_id, domain, max_minutes) VALUES (?, ?, ?)`,
    [userId || '', domain.toLowerCase().replace(/^www\./, ""), maxMinutes],
  );
  return { id: result.lastInsertRowid };
}

/**
 * Update an existing daily goal (only if it belongs to the user).
 */
async function updateGoal(id, fields, userId) {
  const goal = await driver.get("SELECT user_id FROM daily_goals WHERE id = ?", [id]);
  if (!goal || goal.user_id !== userId) return { updated: false };

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
 * Delete a daily goal (only if it belongs to the user).
 */
async function deleteGoal(id, userId) {
  const goal = await driver.get("SELECT user_id FROM daily_goals WHERE id = ?", [id]);
  if (!goal || goal.user_id !== userId) return { deleted: false };

  const result = await driver.run("DELETE FROM daily_goals WHERE id = ?", [id]);
  return { deleted: result.changes > 0 };
}

/**
 * Get today's usage minutes for a specific domain.
 */
async function getTodayMinutesForDomain(domain, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await driver.get(
    `SELECT ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 2) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") = ? AND domain = ? AND user_id = ?`,
    [today, domain, userId || ''],
  );
  return (row && Number(row.totalMinutes)) || 0;
}

/**
 * Get goal status — compare today's usage against the user's enabled goals.
 */
async function getGoalStatus(userId) {
  const goals = await getGoals(userId);
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
      exceeded: todayMinutes > goal.max_minutes,
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
      allowSeed: !driver.isPostgres,
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

    if (!["week", "month", "7days", "30days", "custom"].includes(period)) {
      return res.status(400).json({ status: "error", message: "Invalid period. Use 'week', 'month', '7days', '30days', or 'custom'." });
    }

    let start, end;
    if (period === "custom") {
      start = req.query.startDate;
      end = req.query.endDate;
      if (!start || !end) {
        return res.status(400).json({ status: "error", message: "startDate and endDate are required for custom period" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        return res.status(400).json({ status: "error", message: "Invalid date format. Use YYYY-MM-DD." });
      }
    } else {
      if (referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
        return res.status(400).json({ status: "error", message: "Invalid date format. Use YYYY-MM-DD." });
      }
      const range = getPeriodRange(referenceDate, period);
      start = range.start;
      end = range.end;
    }
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
      allowSeed: !driver.isPostgres,
    });
  } catch (err) {
    console.error("[summary] Error aggregating data:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ─── Goals Routes ───────────────────────────────────────────────────────────

app.get("/api/goals", async (req, res) => {
  try {
    const userId = req.query.user || '';
    const goals = await getGoals(userId);
    return res.json({ goals });
  } catch (err) {
    console.error("[goals] Error fetching goals:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.post("/api/goals", async (req, res) => {
  try {
    const { domain, max_minutes, userToken } = req.body;

    if (!domain || !max_minutes) {
      return res.status(400).json({ status: "error", message: "Missing required fields: domain, max_minutes" });
    }

    if (typeof max_minutes !== "number" || max_minutes <= 0) {
      return res.status(400).json({ status: "error", message: "max_minutes must be a positive number" });
    }

    if (!userToken) {
      return res.status(400).json({ status: "error", message: "Missing userToken" });
    }

    const result = await createGoal(domain, max_minutes, userToken);
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

    const userId = req.query.user || '';
    const result = await updateGoal(id, req.body, userId);
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

    const userId = req.query.user || '';
    const result = await deleteGoal(id, userId);
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

/**
 * DELETE /api/cleanup
 * Removes screen-time records for a specific domain and user.
 */
app.delete("/api/cleanup", async (req, res) => {
  try {
    const userId = req.query.user || '';
    const domain = req.query.domain || '';

    if (!userId || !domain) {
      return res.status(400).json({ status: "error", message: "Missing required params: user, domain" });
    }

    const result = await driver.run(
      `DELETE FROM screen_time WHERE user_id = ? AND domain = ?`,
      [userId, domain]
    );

    console.log(`[cleanup] Deleted ${result.changes} records for user="${userId}" domain="${domain}"`);

    return res.json({ status: "ok", deleted: result.changes });
  } catch (err) {
    console.error("[cleanup] Error:", err);
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


// ─── Seed Data Route ─────────────────────────────────────────────────────────
// ONLY available when using SQLite (local dev). Never available on PostgreSQL (production).

const SEED_DOMAINS = [
  { domain: "youtube.com", duration: 2700, path: "/watch" },
  { domain: "github.com", duration: 1800, path: "/" },
  { domain: "stackoverflow.com", duration: 1200, path: "/questions" },
  { domain: "reddit.com", duration: 1500, path: "/r/programming" },
  { domain: "google.com", duration: 900, path: "/search" },
  { domain: "gmail.com", duration: 600, path: "/inbox" },
  { domain: "twitter.com", duration: 900, path: "/home" },
  { domain: "medium.com", duration: 480, path: "/" },
  { domain: "news.ycombinator.com", duration: 300, path: "/" },
  { domain: "docs.google.com", duration: 720, path: "/document" },
];

const SEED_GOALS = [
  { domain: "youtube.com", max_minutes: 60 },
  { domain: "reddit.com", max_minutes: 20 },
  { domain: "twitter.com", max_minutes: 10 },
  { domain: "github.com", max_minutes: 45 },
];

/**
 * POST /api/seed
 * Generates sample screen-time data and goals for local development testing.
 * Only works with SQLite (local). Returns 403 on PostgreSQL (production).
 */
app.post("/api/seed", async (req, res) => {
  try {
    if (driver.isPostgres) {
      return res.status(403).json({
        status: "error",
        message: "Seed data is only available in local development (SQLite) mode.",
      });
    }

    const userId = req.query.user || "localhost-dev";
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();

    // Clear existing data for this user
    await driver.run(`DELETE FROM screen_time WHERE user_id = ?`, [userId]);
    await driver.run(`DELETE FROM daily_goals WHERE user_id = ?`, [userId]);

    let screenTimeCount = 0;

    // Generate data for the past 6 days + today (7 days total)
    for (let dayOffset = 6; dayOffset >= 0; dayOffset--) {
      const date = new Date(now);
      date.setDate(date.getDate() - dayOffset);
      const dateStr = date.toISOString().slice(0, 10);

      // Vary the amount per day for realistic patterns
      const dayFactor = 0.5 + Math.random() * 1.0;

      for (const site of SEED_DOMAINS) {
        // Some days randomly skip some sites
        if (Math.random() < 0.2) continue;

        const randomVariation = 0.7 + Math.random() * 0.6;
        const seconds = Math.round(site.duration * dayFactor * randomVariation);

        if (seconds < 10) continue;

        // Spread visits throughout the day
        const hour = Math.floor(Math.random() * 14) + 8; // 8am to 10pm
        const minute = Math.floor(Math.random() * 60);
        date.setHours(hour, minute, 0, 0);
        const timestamp = date.toISOString();

        await driver.run(
          `INSERT INTO screen_time (user_id, domain, path, "durationSeconds", "timestamp", recovered)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, site.domain, site.path, seconds, timestamp, driver.isPostgres ? false : 0]
        );
        screenTimeCount++;
      }
    }

    // Create sample goals for this user
    let goalCount = 0;
    for (const goal of SEED_GOALS) {
      await driver.run(
        `INSERT INTO daily_goals (user_id, domain, max_minutes) VALUES (?, ?, ?)`,
        [userId, goal.domain, goal.max_minutes]
      );
      goalCount++;
    }

    console.log(`[seed] Created ${screenTimeCount} screen-time records and ${goalCount} goals for user "${userId}"`);

    return res.status(201).json({
      status: "ok",
      message: `Generated sample data for the past 7 days.`,
      stats: {
        screenTimeRecords: screenTimeCount,
        goals: goalCount,
        userId: userId,
        daysGenerated: 7,
      },
    });
  } catch (err) {
    console.error("[seed] Error generating seed data:", err);
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
║  POST  /api/seed          ← Seed data (local)    ║
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
