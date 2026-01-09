"use strict";

// LORDKARMA Session Generator API
// - POST /api/pair { number, secret? } -> { ok, session_id, code, expires_at }
// - GET  /api/status/:id -> { ok, status, ... }
// - GET  /api/session/:id -> { ok, zip_base64 }  (ONLY after successful link)

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

// --------------------
// Middleware
// --------------------

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

// --------------------
// Paths / storage
// --------------------

const SESS_DIR = path.join(process.cwd(), "sessions");
const ACTIVE_DIR = path.join(process.cwd(), "active");

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

function makeSessionId() {
  return `LK-${Date.now()}-${makeid(4)}`;
}

function statusPath(sessionId) {
  return path.join(ACTIVE_DIR, `${sessionId}.json`);
}

function readStatus(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(sessionId), "utf-8"));
  } catch (_) {
    return null;
  }
}

function writeStatus(sessionId, patch) {
  ensureDir(ACTIVE_DIR);
  const prev = readStatus(sessionId) || {};
  const next = { ...prev, ...patch };
  try {
    fs.writeFileSync(statusPath(sessionId), JSON.stringify(next, null, 2));
  } catch (_) {}
  // mirror to DB (don’t block)
  dbUpsert(sessionId, next).catch(() => {});
}

function credsPath(sessionId) {
  return path.join(SESS_DIR, sessionId, "creds.json");
}

function isRegisteredSession(sessionId) {
  const p = credsPath(sessionId);
  if (!fs.existsSync(p)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(p, "utf-8"));
    return !!creds?.registered;
  } catch (_) {
    return false;
  }
}

async function zipFolderToBuffer(folderPath) {
  return await new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];
    archive.on("warning", (err) => console.warn("[zip warning]", err?.message || err));
    archive.on("error", reject);
    archive.on("data", (d) => chunks.push(d));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.directory(folderPath, false);
    archive.finalize();
  });
}

// --------------------
// Secret gate
// --------------------

function checkSecret(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return true; // gate disabled

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

// --------------------
// DB helpers (optional)
// --------------------

async function dbUpsert(session_id, doc) {
  try {
    const col = await getCollection();
    if (!col) return;

    // Avoid Mongo conflict: never set created_at in $set AND $setOnInsert
    const { created_at, ...rest } = doc || {};
    await col.updateOne(
      { session_id },
      {
        $set: { ...rest, session_id, updated_at: Date.now() },
        $setOnInsert: { created_at: created_at || Date.now() },
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

// --------------------
// Pairing core
// --------------------

const PAIR_SOCKETS = new Map();

async function startPairing(num) {
  ensureDir(SESS_DIR);

  const session_id = makeSessionId();
  const sessPath = path.join(SESS_DIR, session_id);
  ensureDir(sessPath);

  const created_at = Date.now();
  const ttlMs = 10 * 60 * 1000; // 10 min
  const expires_at = created_at + ttlMs;

  writeStatus(session_id, { status: "pending", created_at, expires_at, phone: num });

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

  // Mark READY only after creds are registered (link completed)
  let readyDone = false;
  sock.ev.on("connection.update", async (u) => {
    try {
      const connection = u?.connection;
      if (connection === "open") {
        // give time for creds.json to flush
        await delay(1200);

        if (!readyDone && isRegisteredSession(session_id)) {
          readyDone = true;
          writeStatus(session_id, { status: "ready" });

          // Optional: send welcome to the same number (may fail on some accounts)
          const jid = `${num}@s.whatsapp.net`;
          const msg =
            `🖤✨ LORDKARMA SESSION LINKED ✅\n\n` +
            `Session ID:\n${session_id}\n\n` +
            `⚠ Keep this Session ID private.`;

          await delay(2500);
          try {
            await sock.sendMessage(jid, { text: msg });
          } catch (_) {}

          // Keep the socket alive a bit to reduce “Couldn’t link device” issues
          await delay(12_000);
          try {
            sock.ws?.close();
          } catch (_) {}
          try {
            sock.end?.();
          } catch (_) {}
          PAIR_SOCKETS.delete(session_id);
        }
      }

      if (connection === "close") {
        PAIR_SOCKETS.delete(session_id);
      }
    } catch (e) {
      console.log("[connection.update error]", e?.message || e);
    }
  });

  // Request pairing code
  await delay(900);
  const code = await sock.requestPairingCode(num);
  writeStatus(session_id, { code });

  // TTL cleanup
  setTimeout(() => {
    try {
      const st = readStatus(session_id);
      if (st && st.status !== "ready") writeStatus(session_id, { status: "expired" });
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

// --------------------
// Routes
// --------------------

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

// Legacy
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

router.get("/status/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let st = readStatus(id);

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

    if (st.status !== "ready" && isRegisteredSession(id)) {
      writeStatus(id, { status: "ready" });
      st = readStatus(id) || { ...st, status: "ready" };
    }

    return res.json({ ok: true, ...st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "status failed" });
  }
});

router.get("/session/:id", async (req, res) => {
  try {
    const id = req.params.id;

    // If you later decide to store zip_base64 in DB, this still works.
    const db = await dbGet(id);
    if (db && db.zip_base64) {
      return res.json({ ok: true, session_id: id, zip_base64: db.zip_base64 });
    }

    const sessPath = path.join(SESS_DIR, id);
    if (!fs.existsSync(sessPath)) return res.status(404).json({ ok: false, error: "Session not found" });

    // ✅ only allow after successful link
    if (!isRegisteredSession(id)) return res.status(409).json({ ok: false, error: "Session not ready yet" });

    const zipBuf = await zipFolderToBuffer(sessPath);
    return res.json({ ok: true, session_id: id, zip_base64: zipBuf.toString("base64") });
  } catch (e) {
    console.error("[api/session]", e);
    return res.status(500).json({ ok: false, error: "Failed to package session" });
  }
});

module.exports = router;
