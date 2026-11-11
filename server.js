const express = require("express");
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const app = express();
const preferredPorts = process.env.PORT
  ? [Number(process.env.PORT)]
  : [3000, 3001, 3002, 3003, 3004, 5500];
const dbPath = path.join(__dirname, "game.db");
let port = preferredPorts[0];

let db;

// Persists the in-memory SQLite database to disk so high scores remain available after a server restart.
function saveDb() {
  if (!db) return;
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

// Fetches a single SQL row as an object so the server can read a specific player or score record.
function getOne(sqlText, params = []) {
  const stmt = db.prepare(sqlText);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.reset();
  return row;
}

// Fetches every matching SQL row as an array of objects so list and leaderboard queries can be built easily.
function getAll(sqlText, params = []) {
  const stmt = db.prepare(sqlText);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.reset();
  return rows;
}

// Creates or upgrades the SQLite schema and ensures duplicate scores are cleaned up before the app starts serving requests.
async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    const bytes = fs.readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(bytes));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      createdAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY,
      playerId INTEGER NOT NULL,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      wave INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);

  // Keep one saved score per player, including databases created before this rule.
  const duplicateRows = getAll(
    "SELECT id, playerId, score, createdAt FROM scores ORDER BY playerId, score DESC, createdAt ASC, id ASC",
  );
  const retainedPlayers = new Set();
  for (const row of duplicateRows) {
    if (retainedPlayers.has(row.playerId)) {
      db.run("DELETE FROM scores WHERE id = ?", [row.id]);
    } else {
      retainedPlayers.add(row.playerId);
    }
  }
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_player ON scores(playerId)",
  );

  saveDb();
}

app.use(express.json());
// Applies CORS headers and handles OPTIONS preflight requests so the browser can reach the API from any origin.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname));

// Returns the API health status and the active database file name so the client can confirm the backend is running.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, data: { status: "ok", db: path.basename(dbPath) } });
});

// Returns aggregate game counts, player totals, and the best score for the leaderboard summary.
app.get("/api/stats", (req, res) => {
  const games = Number(
    getOne("SELECT COUNT(*) AS games FROM scores")?.games || 0,
  );
  const players = Number(
    getOne("SELECT COUNT(*) AS count FROM players")?.count || 0,
  );
  const best = Number(
    getOne("SELECT COALESCE(MAX(score), 0) AS best FROM scores")?.best || 0,
  );

  res.json({ ok: true, data: { games, players, best } });
});

// Returns the current leaderboard data, sorted by score and capped by the requested limit.
app.get("/api/scores", (req, res) => {
  const limit = Math.min(50, Number(req.query.limit || 10));
  const rows = getAll(
    `SELECT id, playerId, name, score, wave, createdAt FROM scores ORDER BY score DESC, createdAt ASC LIMIT ${limit}`,
  );
  res.json({ ok: true, data: rows });
});

// Accepts a submitted score, sanitizes the player name, and stores the newest best result for each player.
app.post("/api/scores", (req, res) => {
  const { name, score, wave } = req.body || {};

  const cleanName = String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 _.-]/g, "")
    .slice(0, 14);

  if (!cleanName) {
    return res.json({ ok: false, error: "name is required" });
  }

  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    return res.json({ ok: false, error: "invalid score" });
  }
  const normalizedScore = Math.floor(score);
  const normalizedWave = Math.floor(wave) || 1;

  let player = getOne("SELECT id FROM players WHERE name = ?", [cleanName]);
  let playerId;

  if (!player) {
    db.run("INSERT INTO players (name, createdAt) VALUES (?, ?)", [
      cleanName,
      Date.now(),
    ]);
    const last = db.exec("SELECT last_insert_rowid() AS id");
    playerId = Number(last[0]?.values?.[0]?.[0] ?? 0);
  } else {
    playerId = Number(player.id);
  }

  const existingScore = getOne(
    "SELECT id, playerId, name, score, wave, createdAt FROM scores WHERE playerId = ?",
    [playerId],
  );
  if (existingScore) {
    const updated = normalizedScore > Number(existingScore.score);
    const savedScore = { ...existingScore };
    if (updated) {
      savedScore.score = normalizedScore;
      savedScore.wave = normalizedWave;
      savedScore.createdAt = Date.now();
      db.run(
        "UPDATE scores SET name = ?, score = ?, wave = ?, createdAt = ? WHERE id = ?",
        [
          cleanName,
          normalizedScore,
          normalizedWave,
          savedScore.createdAt,
          existingScore.id,
        ],
      );
      saveDb();
    }
    const rank = Number(
      getOne("SELECT COUNT(*) + 1 AS rank FROM scores WHERE score > ?", [
        savedScore.score,
      ])?.rank || 1,
    );
    const total = Number(
      getOne("SELECT COUNT(*) AS count FROM scores")?.count || 0,
    );
    return res.json({
      ok: true,
      data: { ...savedScore, rank, total, existing: true, updated },
    });
  }

  const createdAt = Date.now();

  db.run(
    "INSERT INTO scores (playerId, name, score, wave, createdAt) VALUES (?, ?, ?, ?, ?)",
    [playerId, cleanName, normalizedScore, normalizedWave, createdAt],
  );

  const idResult = db.exec("SELECT last_insert_rowid() AS id");
  const rowId = Number(idResult[0]?.values?.[0]?.[0] ?? 0);
  const rank = Number(
    getOne("SELECT COUNT(*) + 1 AS rank FROM scores WHERE score > ?", [
      normalizedScore,
    ])?.rank || 1,
  );
  const total = Number(
    getOne("SELECT COUNT(*) AS count FROM scores")?.count || 0,
  );

  saveDb();

  res.json({
    ok: true,
    data: {
      id: rowId,
      playerId,
      name: cleanName,
      score: normalizedScore,
      wave: normalizedWave,
      createdAt,
      rank,
      total,
    },
  });
});

// Applies CORS headers and handles OPTIONS preflight requests so the browser can reach the API from any origin.
// Serves the main game page for browser routes while keeping all API endpoints handled by their dedicated handlers.
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

initDb()
  .then(() => {
    // Tries each fallback port in order and starts the HTTP server once a free one is found.
    const listen = (candidatePort) => {
      const server = app.listen(candidatePort, () => {
        port = candidatePort;
        console.log(`Server listening on http://localhost:${port}`);
        console.log(`SQLite database: ${dbPath}`);
      });

      // Handles startup port conflicts by retrying the next available fallback port if the current one is busy.
      server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
          const nextPort =
            preferredPorts[preferredPorts.indexOf(candidatePort) + 1];
          if (nextPort) {
            console.warn(
              `Port ${candidatePort} in use, trying ${nextPort} instead...`,
            );
            listen(nextPort);
            return;
          }
          console.error(
            "No available ports left in the configured fallback list.",
          );
          process.exit(1);
        } else {
          console.error("Server startup error:", error);
          process.exit(1);
        }
      });
    };

    listen(port);
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
