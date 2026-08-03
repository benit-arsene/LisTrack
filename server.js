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
    const query = req.url.includes("?")
      ? req.url.substring(req.url.indexOf("?"))
      : "";
    return res.redirect(301, "/dashboard" + query);
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// ─── Dashboard Route Protection (Google Token → HTTP-only Session Cookie) ──
// Opening /dashboard from the extension carries ?access_token=... (the Google
// OAuth access token from chrome.identity). The server verifies it against
// Google's tokeninfo endpoint, then drops an HTTP-only session cookie for the
// verified email and serves the dashboard. Any missing/invalid token — or a
// legacy /dashboard?user=... link — bounces straight back to the landing page.

const manifest = require("./manifest.json");
const OAUTH_CLIENT_ID =
  (manifest.oauth2 && manifest.oauth2.client_id) || "";
const LANDING_URL =
  process.env.LANDING_URL || "https://listrack-2.onrender.com/";
const SESSION_COOKIE = "lisTrackSession";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const DASHBOARD_HTML_PATH = path.join(
  __dirname,
  "public",
  "html",
  "dashboard.html",
);

/**
 * Minimal cookie header parser (avoids a new dependency).
 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch (_) {
      cookies[key] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

/**
 * Basic sanity check for an email-shaped value.
 */
function isValidEmail(email) {
  return (
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
      email,
    )
  );
}

/**
 * In-memory cache of Google access tokens verified via tokeninfo.
 * The extension's API calls (badge, goal checks, popup summary, screen-time
 * posts) hit the server far more often than the /dashboard page, so caching
 * avoids a Google round-trip on every request. Access tokens live ~1 hour;
 * we cache for at most 10 minutes.
 */

const verifiedTokenCache = new Map(); // accessToken → { email, expiresAt }
const TOKEN_CACHE_MAX_MS = 10 * 60 * 1000;

function getCachedVerifiedToken(accessToken) {
  const entry = verifiedTokenCache.get(accessToken);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    verifiedTokenCache.delete(accessToken);
    return null;
  }
  return entry.email;
}

function cacheVerifiedToken(accessToken, email, ttlMs) {
  // Bound the cache so attacker-spammed garbage tokens can't grow it unbounded.
  if (verifiedTokenCache.size > 500) verifiedTokenCache.clear();
  verifiedTokenCache.set(accessToken, {
    email,
    expiresAt: Date.now() + Math.min(Math.max(ttlMs, 1000), TOKEN_CACHE_MAX_MS),
  });
}

/**
 * Verify a Google OAuth access token against Google's tokeninfo endpoint.
 * Returns the verified (lowercased) email, or null when the token is
 * invalid, expired, or was not issued to our OAuth client.
 * Freshly-verified tokens are cached in memory to keep re-checks cheap.
 */
async function verifyGoogleAccessToken(accessToken) {
  if (typeof accessToken !== "string" || !accessToken.trim()) return null;
  const token = accessToken.trim();

  const cached = getCachedVerifiedToken(token);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) return null; // invalid / expired token → HTTP 400
    const info = await resp.json();

    // Email must be present, verified, and shaped like an email.
    const emailVerified =
      info.email_verified === "true" || info.email_verified === true;
    if (!emailVerified || !isValidEmail(info.email || "")) return null;

    // The token must have been issued to OUR OAuth client (extension client_id).
    if (OAUTH_CLIENT_ID && info.aud !== OAUTH_CLIENT_ID) {
      console.warn(
        `[auth] Token audience mismatch: expected ${OAUTH_CLIENT_ID}, got ${info.aud}`,
      );
      return null;
    }

    const email = String(info.email).trim().toLowerCase();
    const expiresIn = parseInt(info.expires_in, 10);
    const ttlMs =
      (expiresIn > 0 ? expiresIn - 60 : TOKEN_CACHE_MAX_MS / 1000) * 1000;
    cacheVerifiedToken(token, email, ttlMs);
    return email;
  } catch (err) {
    console.error("[auth] Google token verification failed:", err.message);
    return null;
  }
}

function redirectToLanding(res) {
  return res.redirect(302, LANDING_URL);
}

/**
 * Session authentication middleware for sensitive /api/* endpoints.
 *
 * The authenticated identity is resolved from (in order):
 *   1. The `lisTrackSession` cookie — minted by /dashboard after the Google
 *      access token was verified (used by same-origin browser calls).
 *   2. An `Authorization: Bearer <Google access token>` header — used by the
 *      extension's cross-origin calls (service worker, popup).
 *
 * The claimed user (req.query.user / req.body.userToken / x-user-token header)
 * must match the authenticated email, otherwise the request is rejected with
 * 401 JSON before the route handler runs.
 */
async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const sessionEmail = cookies[SESSION_COOKIE]
      ? String(cookies[SESSION_COOKIE]).trim().toLowerCase()
      : "";

    let headerEmail = "";
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      headerEmail =
        (await verifyGoogleAccessToken(authHeader.slice(7).trim())) || "";
    }

    const authenticatedEmail = sessionEmail || headerEmail;
    if (!isValidEmail(authenticatedEmail)) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized — sign in with Google to access your data.",
      });
    }

    // Resolve the user this request claims to act on behalf of.
    let claimed = (req.query && req.query.user) || "";
    if (!claimed && req.body && typeof req.body === "object" && req.body.userToken) {
      claimed = req.body.userToken;
    }
    // text/plain bodies (legacy sendBeacon path) keep userToken inside the
    // string — parse it so the claimed user is still enforced.
    if (!claimed && req.body && typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body);
        if (parsed && parsed.userToken) claimed = parsed.userToken;
      } catch (_) {}
    }
    if (!claimed) claimed = req.headers["x-user-token"] || "";

    if (claimed) {
      if (String(claimed).trim().toLowerCase() !== authenticatedEmail) {
        console.warn(
          `[auth] 401: session is ${authenticatedEmail}, request claims ${claimed}`,
        );
        return res.status(401).json({
          status: "error",
          message: "Unauthorized — session does not match the requested user.",
        });
      }
    }

    req.authenticatedUser = authenticatedEmail;
    next();
  } catch (err) {
    console.error("[auth] requireAuth error:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

/**
 * Serve the dashboard at the clean /dashboard URL.
 *
 *   ?access_token=...    → verify against Google, set an HTTP-only session
 *                          cookie, redirect to /dashboard (the token never
 *                          stays in the URL bar, history, or server logs).
 *   valid session cookie → serve the dashboard with the user identity injected.
 *   anything else        → immediately redirect to the landing page.
 *   (missing token, invalid token, or a legacy /dashboard?user=... link)
 */
app.get("/dashboard", async (req, res) => {
  const query = req.query || {};
  const cookies = parseCookies(req.headers.cookie);

  // Legacy unauthenticated /dashboard?user=... links are rejected outright.
  if (query.user) {
    console.warn("[auth] Rejected legacy /dashboard?user= access");
    return redirectToLanding(res);
  }

  // ─── Token exchange path ────────────────────────────────────────────
  const accessToken = query.access_token || null;
  if (accessToken) {
    const email = await verifyGoogleAccessToken(accessToken);
    if (!email) {
      console.warn("[auth] Rejected dashboard access — invalid Google token");
      return redirectToLanding(res);
    }

    // HTTP-only session cookie for the verified email. Never readable by JS.
    const isSecure =
      req.secure ||
      String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim() === "https";
    res.cookie(SESSION_COOKIE, email, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      path: "/",
    });
    console.log(`[auth] Dashboard session started for ${email}`);

    // Drop the token from the URL, keeping only benign params (goal/period/date).
    const safeParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (["user", "access_token", "token"].includes(key)) continue;
      if (value != null) safeParams.set(key, value);
    }
    const qs = safeParams.toString();
    return res.redirect(302, "/dashboard" + (qs ? "?" + qs : ""));
  }

  // ─── Session cookie path ────────────────────────────────────────────
  const sessionEmail = cookies[SESSION_COOKIE];
  if (!isValidEmail(sessionEmail || "")) {
    console.warn("[auth] Rejected dashboard access — no valid session");
    return redirectToLanding(res);
  }

  // Inject the authenticated identity so dashboard.js can scope its API calls.
  const email = String(sessionEmail).trim().toLowerCase();
  const safeEmail = email
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  const meta = `<meta name="lisTrack-user" content="${safeEmail}" />`;

  let html;
  try {
    html = fs.readFileSync(DASHBOARD_HTML_PATH, "utf8");
  } catch (err) {
    console.error("[auth] Failed to read dashboard.html:", err);
    return res.status(500).send("Internal server error");
  }
  html = html.replace("</head>", meta + "</head>");
  // Per-user HTML — never let the browser cache it.
  res.set("Cache-Control", "no-store");
  res.type("html").send(html);
});

// Root route — serve index.html from public/html/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "html", "index.html"));
});

// ─── Database Abstraction ───────────────────────────────────────────────────
// Two drivers: PostgreSQL (production) and SQLite (local dev)
// Both expose the same async interface: { init, all, get, run, close }

const DATA_DIR = path.resolve(__dirname, "data");
const DB_PATH =
  process.env.DATABASE_PATH || path.join(DATA_DIR, "screen-time.db");
let driver = null;

// ─── Domain Normalization ─────────────────────────────────────────────────
// Reduce any user-supplied domain/URL to a bare lowercase hostname.
// Strips scheme, www., port, path, query and hash — mirrors what the
// extension sends (window.location.hostname) and guards the server against
// payloads that arrive with full URLs (old clients, direct API calls).

function normalizeDomain(raw) {
  if (typeof raw !== "string") return "";
  let input = raw.trim().toLowerCase();
  if (!input) return "";

  // Prepend a scheme so new URL() parses bare hostnames like
  // "gemini.google.com" as well as full URLs.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = "http://" + input;
  }

  let hostname = "";
  try {
    hostname = new URL(input).hostname;
  } catch (_) {
    // Manual fallback: scheme → authority, then drop path/query/hash/port.
    let host = input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    host = host.split(/[/?#]/)[0];
    host = host.replace(/:\d+$/, "");
    hostname = host;
  }

  hostname = hostname.replace(/^www\./, "").replace(/\.$/, "").toLowerCase();
  // Must still look like a hostname (letters/digits/dots/hyphens)
  if (!hostname || !/^[a-z0-9][a-z0-9.-]*$/.test(hostname)) return "";
  return hostname;
}

// ─── SQLite Driver (sql.js — pure JS, no native compilation) ────────────────

async function createSqliteDriver() {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();

  let db;
  // Ensure the database directory exists (DATABASE_PATH may point anywhere)
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log(`[db] Loaded existing SQLite database from ${DB_PATH}`);
  } else {
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
        const columns = tableInfo[0]?.values?.map((v) => v[1]) || [];
        if (!columns.includes("user_id")) {
          db.run(
            "ALTER TABLE screen_time ADD COLUMN user_id TEXT NOT NULL DEFAULT ''",
          );
          console.log(
            "[db] SQLite migration: added user_id column to screen_time",
          );
        }
        // Create index AFTER we've verified/added the column — old DBs
        // without user_id would crash if this index were in the schema DDL.
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id)",
        );
      } catch (err) {
        console.error("[db] SQLite migration error:", err.message);
      }

      // Migration: add seq_id column for deduplication
      // IMPORTANT: The index is created INSIDE the same try block, AFTER the ALTER TABLE.
      // This avoids crash on existing databases where sql_schema DDL's CREATE INDEX
      // would fail because seq_id didn't exist yet on the old table.
      try {
        const tableInfo = db.exec("PRAGMA table_info('screen_time')");
        const columns = tableInfo[0]?.values?.map((v) => v[1]) || [];
        if (!columns.includes("seq_id")) {
          db.run(
            "ALTER TABLE screen_time ADD COLUMN seq_id INTEGER DEFAULT NULL",
          );
          console.log(
            "[db] SQLite migration: added seq_id column to screen_time",
          );
        }
        // Create index AFTER we've verified/added the column
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_screen_time_seq_id ON screen_time(seq_id)",
        );
        // Deduplicate any existing (user_id, seq_id) collisions before
        // enforcing uniqueness (legacy per-tab counters could collide).
        db.run(
          `DELETE FROM screen_time WHERE seq_id IS NOT NULL AND id NOT IN (
             SELECT MIN(id) FROM screen_time WHERE seq_id IS NOT NULL
             GROUP BY user_id, seq_id
           )`,
        );
        // UNIQUE index — enables INSERT ... ON CONFLICT dedup
        db.run(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_screen_time_user_seq ON screen_time(user_id, seq_id)",
        );
      } catch (err) {
        console.error("[db] SQLite migration error (seq_id):", err.message);
      }

      // Verify the unique index exists — INSERT ... ON CONFLICT depends on it
      try {
        const idxList = db.exec("PRAGMA index_list('screen_time')");
        const hasUserSeq = (idxList[0]?.values || []).some(
          (row) => row[1] === "idx_screen_time_user_seq",
        );
        if (!hasUserSeq) {
          console.error(
            "[db] WARNING: unique index idx_screen_time_user_seq missing — seq_id dedup (ON CONFLICT) will fail. Remove duplicate (user_id, seq_id) rows.",
          );
        }
      } catch (_) {}

      // Migration: add user_id column to daily_goals
      try {
        const goalsInfo = db.exec("PRAGMA table_info('daily_goals')");
        const goalCols = goalsInfo[0]?.values?.map((v) => v[1]) || [];
        if (!goalCols.includes("user_id")) {
          db.run(
            "ALTER TABLE daily_goals ADD COLUMN user_id TEXT NOT NULL DEFAULT ''",
          );
          console.log(
            "[db] SQLite migration: added user_id column to daily_goals",
          );
        }
        // Create index on user_id (safe to run even if column already existed)
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_daily_goals_user ON daily_goals(user_id)",
        );
      } catch (err) {
        console.error(
          "[db] SQLite migration error (daily_goals):",
          err.message,
        );
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
          await pool.query(
            `ALTER TABLE screen_time ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
          );
          console.log("[db] PostgreSQL migration: added user_id column");
        }
        // Create index AFTER we've verified/added the column — old tables
        // without user_id would crash if this index were in the schema DDL.
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id)`,
        );
      } catch (err) {
        console.error("[db] PostgreSQL migration error:", err.message);
      }

      // Migration: add seq_id column for deduplication
      // IMPORTANT: The index is created INSIDE the same try block, AFTER the ALTER
      // TABLE ADD COLUMN (or at least after we've verified the column exists).
      // This avoids crash on existing databases where sql_schema_pg DDL's CREATE
      // INDEX would fail because seq_id didn't exist yet on the old table.
      try {
        const colResult = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'screen_time' AND column_name = 'seq_id'
        `);
        if (colResult.rows.length === 0) {
          await pool.query(
            `ALTER TABLE screen_time ADD COLUMN seq_id INTEGER DEFAULT NULL`,
          );
          console.log("[db] PostgreSQL migration: added seq_id column");
        }
        // Create index AFTER we've verified/added the column
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_screen_time_seq_id ON screen_time(seq_id)`,
        );
        // Widen seq_id to TEXT so UUID-based ids fit (legacy INTEGER column)
        const typeResult = await pool.query(`
          SELECT data_type FROM information_schema.columns
          WHERE table_name = 'screen_time' AND column_name = 'seq_id'
        `);
        if (
          typeResult.rows.length > 0 &&
          String(typeResult.rows[0].data_type).toLowerCase() === "integer"
        ) {
          await pool.query(
            `ALTER TABLE screen_time ALTER COLUMN seq_id TYPE TEXT USING seq_id::text`,
          );
          console.log("[db] PostgreSQL migration: widened seq_id to TEXT");
        }
        // Deduplicate any existing (user_id, seq_id) collisions before
        // enforcing uniqueness (legacy per-tab counters could collide).
        await pool.query(`
          DELETE FROM screen_time a USING screen_time b
          WHERE a.id > b.id
            AND a.user_id = b.user_id
            AND a.seq_id = b.seq_id
            AND a.seq_id IS NOT NULL
        `);
        // UNIQUE index — enables INSERT ... ON CONFLICT dedup
        await pool.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_screen_time_user_seq ON screen_time(user_id, seq_id)`,
        );
      } catch (err) {
        console.error("[db] PostgreSQL migration error (seq_id):", err.message);
      }

      // Verify the unique index exists — INSERT ... ON CONFLICT depends on it
      try {
        const idxRes = await pool.query(
          `SELECT 1 FROM pg_indexes WHERE tablename = 'screen_time' AND indexname = 'idx_screen_time_user_seq'`,
        );
        if (idxRes.rows.length === 0) {
          console.error(
            "[db] WARNING: unique index idx_screen_time_user_seq missing — seq_id dedup (ON CONFLICT) will fail.",
          );
        }
      } catch (_) {}

      // Migration: ensure indexes exist for new columns
      try {
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_screen_time_user ON screen_time(user_id)`,
        );
      } catch (err) {
        console.error("[db] PostgreSQL index migration error:", err.message);
      }

      // Migration: add user_id column to daily_goals
      try {
        const colResult = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'daily_goals' AND column_name = 'user_id'
        `);
        if (colResult.rows.length === 0) {
          await pool.query(
            `ALTER TABLE daily_goals ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
          );
          console.log(
            "[db] PostgreSQL migration: added user_id column to daily_goals",
          );
        }
        // Create index on user_id (safe to run even if column already existed)
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_daily_goals_user ON daily_goals(user_id)`,
        );
      } catch (err) {
        console.error(
          "[db] PostgreSQL migration error (daily_goals):",
          err.message,
        );
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
      const sqlToRun = sql.trim().toUpperCase().startsWith("INSERT")
        ? sql + " RETURNING id"
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
    seq_id          TEXT DEFAULT NULL,
    recovered       INTEGER NOT NULL DEFAULT 0,
    ingested_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_screen_time_domain ON screen_time(domain);
  CREATE INDEX IF NOT EXISTS idx_screen_time_timestamp ON screen_time(timestamp);

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
    seq_id          TEXT DEFAULT NULL,
    recovered       BOOLEAN NOT NULL DEFAULT FALSE,
    ingested_at     TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_screen_time_domain ON screen_time(domain);
  CREATE INDEX IF NOT EXISTS idx_screen_time_timestamp ON screen_time(timestamp);

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
 * Insert a screen-time log entry into storage with deduplication.
 *
 * DEDUP: If the entry includes a seq_id, we check if it has already been
 * processed. This prevents double-counting when crash-recovered payloads
 * are replayed after the original had already been saved.
 *
 * PRECISION: durationSeconds is stored at full precision (DOUBLE/REAL).
 * Only the aggregation queries round, preserving granularity.
 */
async function insertScreenTimeLog(entry) {
  const userId = entry.userId || "";

  // ─── Dedup by (user_id, seq_id) — atomic ──────────────────────────
  // INSERT ... ON CONFLICT DO NOTHING relies on the UNIQUE index
  // idx_screen_time_user_seq, so the check-and-insert happens atomically
  // in one statement — no SELECT-then-INSERT race, and dedup is scoped to
  // the user (two users can safely share the same seq_id).
  if (entry.seq_id != null) {
    const result = await driver.run(
      `INSERT INTO screen_time (user_id, domain, path, "durationSeconds", "timestamp", seq_id, recovered)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, seq_id) DO NOTHING`,
      [
        userId,
        entry.domain,
        entry.path,
        entry.durationSeconds,
        entry.timestamp,
        entry.seq_id,
        driver.isPostgres ? !!entry.recovered : entry.recovered ? 1 : 0,
      ],
    );

    if (result.changes === 0) {
      // Conflict — row already exists for this user + seq_id.
      const existing = await driver.get(
        `SELECT id FROM screen_time WHERE user_id = ? AND seq_id = ?`,
        [userId, entry.seq_id],
      );
      if (existing) {
        console.log(
          `[screen-time] Dedup: seq_id ${entry.seq_id} already exists (id=${existing.id})`,
        );
      }
      entry._id = existing ? existing.id : null;
      return entry; // Skip insert — already counted
    }

    entry._id = result.lastInsertRowid;
    return entry;
  }

  // No seq_id (e.g. seed data) — plain insert
  const result = await driver.run(
    `INSERT INTO screen_time (user_id, domain, path, "durationSeconds", "timestamp", seq_id, recovered)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      entry.domain,
      entry.path,
      entry.durationSeconds,
      entry.timestamp,
      null,
      driver.isPostgres ? !!entry.recovered : entry.recovered ? 1 : 0,
    ],
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
    [userId || ""],
  );
  return rows.map((row) => ({
    ...row,
    recovered: row.recovered === 1 || row.recovered === true,
  }));
}

/**
 * Aggregate screen-time logs grouped by domain for a given date.
 *
 * PRECISION FIX: Round to 6 decimal places instead of 2. This preserves
 * sub-second precision (1 second = 0.016666 minutes). With 2 decimal places,
 * anything below 0.005 minutes (~0.3 seconds) rounded to zero, losing data.
 * With 6 decimal places, sub-millisecond precision is preserved.
 */
async function getAggregatedByDomain(date, userId) {
  const dateValue = date || new Date().toISOString().slice(0, 10);
  const rows = await driver.all(
    `SELECT domain, ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 6) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") = ? AND user_id = ?
     GROUP BY domain
     ORDER BY "totalMinutes" DESC`,
    [dateValue, userId || ""],
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
     WHERE date("timestamp") IS NOT NULL AND user_id = ?
     ORDER BY d DESC`,
    [userId || ""],
  );
  return rows.map((row) => row.d);
}

/**
 * Calculate the start and end date of a period (week or month) containing
 * the given reference date.
 */
function getPeriodRange(dateStr, period) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return { start: dateStr, end: dateStr };

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
    `SELECT domain, ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 6) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") >= ? AND date("timestamp") <= ? AND user_id = ?
     GROUP BY domain
     ORDER BY "totalMinutes" DESC`,
    [startDate, endDate, userId || ""],
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
    `SELECT date("timestamp") AS d, ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 6) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") IS NOT NULL AND date("timestamp") >= ? AND date("timestamp") <= ? AND user_id = ?
     GROUP BY date("timestamp")
     ORDER BY d ASC`,
    [startDate, endDate, userId || ""],
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
  // domain is already normalized by the route via normalizeDomain()
  const result = await driver.run(
    `INSERT INTO daily_goals (user_id, domain, max_minutes) VALUES (?, ?, ?)`,
    [userId || "", domain, maxMinutes],
  );
  return { id: result.lastInsertRowid };
}

/**
 * Update an existing daily goal (only if it belongs to the user).
 */
async function updateGoal(id, fields, userId) {
  const goal = await driver.get(
    "SELECT user_id FROM daily_goals WHERE id = ?",
    [id],
  );
  if (!goal || goal.user_id !== userId) return { updated: false };

  const sets = [];
  const values = [];

  if (fields.domain !== undefined) {
    const cleanedDomain = normalizeDomain(fields.domain);
    if (!cleanedDomain) return { updated: false, invalidDomain: true };
    sets.push("domain = ?");
    values.push(cleanedDomain);
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
  const goal = await driver.get(
    "SELECT user_id FROM daily_goals WHERE id = ?",
    [id],
  );
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
    `SELECT ROUND(CAST(SUM("durationSeconds") / 60.0 AS NUMERIC), 6) AS "totalMinutes"
     FROM screen_time
     WHERE date("timestamp") = ? AND domain = ? AND user_id = ?`,
    [today, domain, userId || ""],
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
app.post("/api/screen-time", requireAuth, async (req, res) => {
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

    const userToken = payload.userToken || req.headers["x-user-token"] || "";

    if (!payload || !payload.domain || !payload.durationSeconds) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: domain, durationSeconds",
        received: payload,
      });
    }

    if (
      typeof payload.durationSeconds !== "number" ||
      payload.durationSeconds < 0
    ) {
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
      domain: normalizeDomain(payload.domain),
      path: String(payload.path || "/"),
      durationSeconds: payload.durationSeconds,
      timestamp: payload.timestamp || new Date().toISOString(),
      seq_id: payload.seq_id != null ? String(payload.seq_id) : null,
      recovered: payload.recovered === true,
    };

    if (
      entry.domain === "localhost" ||
      entry.domain === "127.0.0.1" ||
      entry.domain === ""
    ) {
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
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/dashboard
 * Returns aggregated screen-time data grouped by domain for a given date.
 */
app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const requestedDate = req.query.date || null;

    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Invalid date format. Use YYYY-MM-DD.",
        });
    }

    const userId = req.query.user || "";
    const domains = await getAggregatedByDomain(requestedDate, userId);
    const availableDates = await getAvailableDates(userId);

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
      allowSeed: !driver.isPostgres,
    });
  } catch (err) {
    console.error("[dashboard] Error aggregating data:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/summary
 * Returns aggregated screen-time data grouped by domain for a week or month period.
 */
app.get("/api/summary", requireAuth, async (req, res) => {
  try {
    const period = req.query.period || "week";
    const referenceDate =
      req.query.date || new Date().toISOString().slice(0, 10);

    if (!["week", "month", "7days", "30days", "custom"].includes(period)) {
      return res
        .status(400)
        .json({
          status: "error",
          message:
            "Invalid period. Use 'week', 'month', '7days', '30days', or 'custom'.",
        });
    }

    let start, end;
    if (period === "custom") {
      start = req.query.startDate;
      end = req.query.endDate;
      if (!start || !end) {
        return res
          .status(400)
          .json({
            status: "error",
            message: "startDate and endDate are required for custom period",
          });
      }
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(end)
      ) {
        return res
          .status(400)
          .json({
            status: "error",
            message: "Invalid date format. Use YYYY-MM-DD.",
          });
      }
    } else {
      if (referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
        return res
          .status(400)
          .json({
            status: "error",
            message: "Invalid date format. Use YYYY-MM-DD.",
          });
      }
      const range = getPeriodRange(referenceDate, period);
      start = range.start;
      end = range.end;
    }
    const userId = req.query.user || "";

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
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

// ─── Goals Routes ───────────────────────────────────────────────────────────

app.get("/api/goals", requireAuth, async (req, res) => {
  try {
    const userId = req.query.user || "";
    const goals = await getGoals(userId);
    return res.json({ goals });
  } catch (err) {
    console.error("[goals] Error fetching goals:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

app.post("/api/goals", requireAuth, async (req, res) => {
  try {
    const { domain, max_minutes, userToken } = req.body;

    if (!domain || !max_minutes) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Missing required fields: domain, max_minutes",
        });
    }

    if (typeof max_minutes !== "number" || max_minutes <= 0) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "max_minutes must be a positive number",
        });
    }

    if (!userToken) {
      return res
        .status(400)
        .json({ status: "error", message: "Missing userToken" });
    }

    const cleanedDomain = normalizeDomain(domain);
    if (!cleanedDomain) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Invalid domain. Use a bare hostname like gemini.google.com",
        });
    }

    const result = await createGoal(cleanedDomain, max_minutes, userToken);
    return res.status(201).json({ status: "ok", id: result.id });
  } catch (err) {
    console.error("[goals] Error creating goal:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

app.put("/api/goals/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid goal ID" });
    }

    const userId = req.query.user || "";
    const result = await updateGoal(id, req.body, userId);
    if (result.invalidDomain) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid domain. Use a bare hostname like gemini.google.com" });
    }
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

app.delete("/api/goals/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid goal ID" });
    }

    const userId = req.query.user || "";
    const result = await deleteGoal(id, userId);
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

app.get("/api/goals/status", requireAuth, async (req, res) => {
  try {
    const userId = req.query.user || "";
    const statuses = await getGoalStatus(userId);
    return res.json({ goals: statuses });
  } catch (err) {
    console.error("[goals] Error getting goal status:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

// ─── Donation (Intouch) Routes ────────────────────────────────────────
//
// These routes integrate with IntouchPay (Rwanda mobile money) to accept
// donations via MTN MoMo and Airtel Money.
//
// To enable live payments, set these environment variables:
//   INTOUCH_USERNAME          — Your IntouchPay API username
//   INTOUCH_ACCOUNT_NO         — Your IntouchPay account number
//   INTOUCH_PARTNER_PASSWORD   — Your IntouchPay partner password
//   INTOUCH_API_URL            — Intouch API base URL (default: https://api.intouchpay.co.rw)
//   DONATION_CALLBACK_URL      — Public URL for Intouch to send callbacks
//
// When credentials are NOT set, the donation runs in "demo mode" — the UI
// shows a confirmation without actually charging anyone.

const registerDonationRoutes = require("./donation");

registerDonationRoutes(app);

app.get("/api/logs", requireAuth, async (req, res) => {
  try {
    const userId = req.query.user || "";
    const logs = await getAllScreenTimeLogs(userId);
    return res.json({ total: logs.length, logs });
  } catch (err) {
    console.error("[logs] Error fetching logs:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

/**
 * GET /api/trends
 * Compares screen-time between the current period and the previous period
 * of the same length, returning per-domain percentage changes.
 *
 * Query params:
 *   period — '7days', '30days', 'week', 'month' (default: '7days')
 *   date   — reference date (default: today)
 *   user   — user token
 */
app.get("/api/trends", requireAuth, async (req, res) => {
  try {
    const period = req.query.period || "7days";
    const referenceDate =
      req.query.date || new Date().toISOString().slice(0, 10);

    if (!["week", "month", "7days", "30days"].includes(period)) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Invalid period. Use 'week', 'month', '7days', or '30days'.",
        });
    }
    if (referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Invalid date format. Use YYYY-MM-DD.",
        });
    }

    const userId = req.query.user || "";

    // Get current period range
    const currentRange = getPeriodRange(referenceDate, period);

    // Calculate previous period (same length, going back)
    const prevEnd = new Date(currentRange.start + "T00:00:00Z");
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const prevEndStr = prevEnd.toISOString().slice(0, 10);

    const periodLengths = { "7days": 7, "30days": 30, week: 7, month: 30 };
    const length = periodLengths[period] || 7;
    const prevStart = new Date(prevEnd);
    prevStart.setUTCDate(prevStart.getUTCDate() - length + 1);
    const prevStartStr = prevStart.toISOString().slice(0, 10);

    // Fetch both periods in parallel
    const [currentDomains, previousDomains] = await Promise.all([
      getAggregatedByDomainForPeriod(
        currentRange.start,
        currentRange.end,
        userId,
      ),
      getAggregatedByDomainForPeriod(prevStartStr, prevEndStr, userId),
    ]);

    // ─── RANK-BASED TREND CALCULATION ────────────────────────────────────
    //
    // BUG FIX: Previous implementation calculated trends as minute-based
    // percentage change (e.g., "▲ 919%"). This produced absurd percentages
    // when a domain had a tiny previous baseline but grew modestly.
    //
    // FIX: Compare domain POSITIONS (ranks) between the two periods:
    //   - Build ranked leaderboards for each period by totalMinutes DESC
    //   - rankChange = PreviousRank - CurrentRank
    //     (positive = moved up in rank, negative = moved down)
    //   - New domains (no previous data) get status: 'new' instead of a fake %
    // ───────────────────────────────────────────────────────────────────────

    // 1. Build ranked leaderboards (1-based index, sorted by time DESC)
    function buildRankedList(domains) {
      // Shallow copy before sort to avoid mutating the original array
      return [...domains]
        .sort((a, b) => b.totalMinutes - a.totalMinutes)
        .map((d, i) => ({
          domain: d.domain,
          totalMinutes: d.totalMinutes,
          rank: i + 1,
        }));
    }

    const currentRanked = buildRankedList(currentDomains);
    const previousRanked = buildRankedList(previousDomains);

    // 2. Build fast lookup maps: domain -> { totalMinutes, rank }
    const currentMap = {};
    for (const entry of currentRanked) {
      currentMap[entry.domain] = entry;
    }
    const previousMap = {};
    for (const entry of previousRanked) {
      previousMap[entry.domain] = entry;
    }

    let prevTotal = previousDomains.reduce((s, d) => s + d.totalMinutes, 0);
    const currTotal = currentDomains.reduce((s, d) => s + d.totalMinutes, 0);

    // 3. Calculate rank-based trend for every domain that exists in
    //    EITHER period (we track from current perspective, but also
    //    include domains that dropped off entirely)
    const trends = [];
    const allDomains = new Set([
      ...currentDomains.map((d) => d.domain),
      ...previousDomains.map((d) => d.domain),
    ]);

    for (const domain of allDomains) {
      const curr = currentMap[domain];
      const prev = previousMap[domain];

      const currMinutes = curr ? curr.totalMinutes : 0;
      const prevMinutes = prev ? prev.totalMinutes : 0;
      const currentRank = curr ? curr.rank : null;
      const previousRank = prev ? prev.rank : null;

      let rankChange = null;
      let status = "same";

      if (curr && !prev) {
        // NEWLY tracked domain — no previous data to compare
        status = "new";
        rankChange = null;
      } else if (!curr && prev) {
        // Domain dropped off entirely — still show it (currentRank = null)
        status = "dropped";
        rankChange = null;
      } else if (previousRank !== null && currentRank !== null) {
        // Domain exists in both periods — compare rank positions
        rankChange = previousRank - currentRank;
        if (rankChange > 0) status = "up";
        else if (rankChange < 0) status = "down";
        else status = "same";
      }

      trends.push({
        domain,
        currentMinutes: Math.round(currMinutes * 100) / 100,
        previousMinutes: Math.round(prevMinutes * 100) / 100,
        currentRank,
        previousRank,
        rankChange,
        status,
      });
    }

    // Sort so that current-period domains (with data) come first, ordered
    // by currentMinutes descending; dropped domains go to the bottom
    trends.sort((a, b) => {
      // Domains with current data come first
      if (a.currentRank !== null && b.currentRank === null) return -1;
      if (a.currentRank === null && b.currentRank !== null) return 1;
      // Both have current data — sort by current rank
      if (a.currentRank !== null && b.currentRank !== null) {
        return a.currentRank - b.currentRank;
      }
      // Both dropped — sort by previous rank
      return (a.previousRank || 999) - (b.previousRank || 999);
    });

    // 4. Overall total change (kept as minute-percentage for the summary badge)
    const totalChange = currTotal - prevTotal;
    const totalChangePercent =
      prevTotal > 0
        ? Math.round((totalChange / prevTotal) * 100)
        : currTotal > 0
          ? 100
          : 0;

    return res.json({
      period,
      currentPeriod: { start: currentRange.start, end: currentRange.end },
      previousPeriod: { start: prevStartStr, end: prevEndStr },
      totalCurrent: Math.round(currTotal * 100) / 100,
      totalPrevious: Math.round(prevTotal * 100) / 100,
      totalChange: Math.round(totalChange * 100) / 100,
      totalChangePercent,
      totalDirection:
        totalChange > 0 ? "up" : totalChange < 0 ? "down" : "flat",
      trends,
    });
  } catch (err) {
    console.error("[trends] Error:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
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
app.post("/api/seed", requireAuth, async (req, res) => {
  try {
    if (driver.isPostgres) {
      return res.status(403).json({
        status: "error",
        message:
          "Seed data is only available in local development (SQLite) mode.",
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
          [
            userId,
            site.domain,
            site.path,
            seconds,
            timestamp,
            driver.isPostgres ? false : 0,
          ],
        );
        screenTimeCount++;
      }
    }

    // Create sample goals for this user
    let goalCount = 0;
    for (const goal of SEED_GOALS) {
      await driver.run(
        `INSERT INTO daily_goals (user_id, domain, max_minutes) VALUES (?, ?, ?)`,
        [userId, goal.domain, goal.max_minutes],
      );
      goalCount++;
    }

    console.log(
      `[seed] Created ${screenTimeCount} screen-time records and ${goalCount} goals for user "${userId}"`,
    );

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
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
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
