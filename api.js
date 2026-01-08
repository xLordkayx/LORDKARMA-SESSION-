"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const pino = require("pino");

const { getCollection } = require("./db");
const { makeid } = require("./id");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  delay,
  Browsers,
} = require("maher-zubair-baileys");

const router = express.Router();

/** =========================
 *  Middleware
 *  ========================= */

router.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-SESSION-SECRET"],
  })
);

const pairLimiter = rateLimit({
  windowMs: 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

/** =========================
 *  Storage paths
 *  ========================= */

// Sessions stored on disk (Render persistent disk recommended if you need long-term storage)
const SESS_DIR = path.join(process.cwd(), "sessions");
const ACTIVE_DIR = path.join(process.cwd(), "active"); // status + expiries

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {}
}

function normalizeNumber(raw) {
  if (!raw) return null;
  const num = String(raw).replace(/[^0-9]/g, "");
  if (num.length < 8) return null;
  return num;
}

/** =========================
 *  Secret gate
 *  ========================= */

function checkSecret(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return true; // disabled
  const provided = (
    req.headers["x-session-secret"] ||
    req.query?.secret ||
    req.body?.secret ||
    req.body?.password ||
    ""
  )
    .toString()
    .trim();
  return provided && provided === secret;
}

function requireSecret(req, res, next) {
  if (checkSecret(req)) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)" });
}

/** =========================
 *  DB helpers (optional)
 *  ========================= */

async function dbUpsert(session_id, patch) {
  try {
    const col = await getCollection();
    if (!col) return;
    await col.updateOne(
      { session_id },
      {
        $set: { ...patch, session_id, updated_at: Date.now() },
        $setOnInsert: { created_at: patch.created_at || Date.now() },
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[dbUpsert]", e?.message || e);
  }
}

async function dbGet(session_id) {
  try {
    const col = await getCollection();
    if (!col) return null;
    return await col.findOne({ session_id });
  } catch (_) {
    return null;
  }
}

/** =========================
 *  Status file helpers
 *  ========================= */

function makeSessionId() {
  const ts = Date.now();
  return `LK-${ts}-${makeid(4)}`;
}

function statusPath(sessionId) {
  return path.join(ACTIVE_DIR, `${sessionId}.json`);
}

function writeStatus(sessionId, data) {
  ensureDir(ACTIVE_DIR);
  try {
    fs.writeFileSync(statusPath(sessionId), JSON.stringify(data, null, 2));
  } catch (_) {}

  // mirror to DB if available (don’t block request)
  dbUpsert(sessionId, data).catch(() => {});
}

function readStatus(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(sessionId), "utf-8"));
  } catch (_) {
    return null;
  }
}

function hasCreds(sessionId) {
  const dir = path.join(SESS_DIR, sessionId);
  return fs.existsSync(path.join(dir, "creds.json"));
}

/** =========================
 *  Zip helper
 *  ========================= */

async function zipFolderToBuffer(folderPath) {
  return await new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];

    archive.on("warning", (err) =>
      console.warn("[zip warning]", err?.message || err)
    );
    archive.on("error", reject);
    archive.on("data", (d) => chunks.push(d));
    archive.on("end", () => resolve(Buffer.concat(chunks)));

    archive.directory(folderPath, false);
    archive.finalize();
  });
}

/** =========================
 *  Live pairing sockets map
 *  ========================= */

const PAIR_SOCKETS = new Map();

/** =========================
 *  Core pairing
 *  ========================= */

async function startPairing(num) {
  ensureDir(SESS_DIR);

  const session_id = makeSessionId();
  const sessPath = path.join(SESS_DIR, session_id);
  ensureDir(sessPath);

  const created_at = Date.now();
  const ttlMs = 10 * 60 * 1000; // 10 minutes
  const expires_at = created_at + ttlMs;

  // mark pending
  writeStatus(session_id, {
    status: "pending",
    created_at,
    expires_at,
    phone: num,
  });

  const { state, saveCreds } = await useMultiFileAuthState(sessPath);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("LORDKARMA Session Portal"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
  });

  PAIR_SOCKETS.set(session_id, sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    try {
      const connection = u?.connection;

      if (connection === "open") {
        const prev = readStatus(session_id) || {};
        writeStatus(session_id, {
          ...prev,
          status: "ready",
          created_at: prev.created_at || created_at,
          expires_at: prev.expires_at || expires_at,
        });

        await delay(1500);
        try {
          sock.ws?.close();
        } catch (_) {}
        try {
          sock.end?.();
        } catch (_) {}
        PAIR_SOCKETS.delete(session_id);
      }

      if (connection === "close") {
        PAIR_SOCKETS.delete(session_id);
      }
    } catch (e) {
      console.log("[connection.update error]", e?.message || e);
    }
  });

  // Request pairing code
  await delay(800);
  const code = await sock.requestPairingCode(num);

  const prev = readStatus(session_id) || {};
  writeStatus(session_id, { ...prev, code });

  // Auto cleanup after TTL
  setTimeout(() => {
    try {
      const st = readStatus(session_id);
      if (st && st.status !== "ready") {
        writeStatus(session_id, { ...st, status: "expired" });
      }
    } catch (_) {}

    const s = PAIR_SOCKETS.get(session_id);
    if (s) {
      try {
        s.ws?.close();
      } catch (_) {}
      try {
        s.end?.();
      } catch (_) {}
      PAIR_SOCKETS.delete(session_id);
    }
  }, ttlMs).unref?.();

  return { session_id, code, expires_at };
}

/** =========================
 *  Routes
 *  ========================= */

/**
 * POST /api/pair
 * body: { number: "2348..." }
 */
router.post("/pair", pairLimiter, requireSecret, async (req, res) => {
  try {
    const raw = req.body?.number || req.body?.phone || req.body?.num;
    const num = normalizeNumber(raw);
    if (!num) return res.status(400).json({ ok: false, error: "Invalid phone number" });

    const out = await startPairing(num);
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[api/pair]", e);
    return res.status(500).json({ ok: false, error: "Pairing service failed" });
  }
});

/**
 * Legacy: GET /api/code?number=...
 * returns: { code, session_id, expires_at }
 */
router.get("/code", async (req, res) => {
  try {
    const num = normalizeNumber(req.query?.number);
    if (!num) return res.status(400).json({ code: "Invalid number" });

    const out = await startPairing(num);
    return res.json({ code: out.code, session_id: out.session_id, expires_at: out.expires_at });
  } catch (e) {
    console.error("[api/code]", e);
    return res.status(500).json({ code: "Service Unavailable" });
  }
});

/**
 * GET /api/status/:id
 */
router.get("/status/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let st = readStatus(id);

    // If not in file, try DB
    if (!st) {
      const d = await dbGet(id);
      if (!d) return res.status(404).json({ ok: false, status: "missing" });
      st = {
        status: d.status,
        created_at: d.created_at,
        expires_at: d.expires_at,
        code: d.code,
        phone: d.phone,
      };
    }

    // If files exist, force ready
    if (st.status !== "ready" && hasCreds(id)) {
      writeStatus(id, { ...st, status: "ready" });
      return res.json({ ok: true, ...readStatus(id) });
    }

    return res.json({ ok: true, ...st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "status failed" });
  }
});

/**
 * GET /api/session/:id
 * returns: { ok:true, session_id, zip_base64 }
 */
router.get("/session/:id", async (req, res) => {
  try {
    const id = req.params.id;

    // If you ever choose to store zip_base64 in DB later, support it:
    const db = await dbGet(id);
    if (db && db.zip_base64) {
      return res.json({ ok: true, session_id: id, zip_base64: db.zip_base64 });
    }

    const sessPath = path.join(SESS_DIR, id);
    if (!fs.existsSync(sessPath)) return res.status(404).json({ ok: false, error: "Session not found" });
    if (!hasCreds(id)) return res.status(409).json({ ok: false, error: "Session not ready yet" });

    const zipBuf = await zipFolderToBuffer(sessPath);
    return res.json({ ok: true, session_id: id, zip_base64: zipBuf.toString("base64") });
  } catch (e) {
    console.error("[api/session]", e);
    return res.status(500).json({ ok: false, error: "Failed to package session" });
  }
});

module.exports = router;
