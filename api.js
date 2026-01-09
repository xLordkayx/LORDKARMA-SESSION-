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
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const router = express.Router();

/* =========================
 * Middleware
 * ========================= */
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

/* =========================
 * Storage
 * ========================= */
const SESS_DIR = path.join(process.cwd(), "sessions");
const ACTIVE_DIR = path.join(process.cwd(), "active");

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {}
}

function normalizeNumber(raw) {
  if (!raw) return null;
  // keep digits only; WhatsApp expects country code without '+'
  const num = String(raw).replace(/[^0-9]/g, "");
  if (num.length < 8) return null;
  return num;
}

/* =========================
 * Secret Gate
 * ========================= */
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

/* =========================
 * DB helpers (optional)
 * ========================= */
async function dbUpsert(session_id, patch) {
  try {
    const col = await getCollection();
    if (!col) return;

    const { created_at, ...rest } = patch || {};
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

/* =========================
 * Status helpers
 * ========================= */
function makeSessionId() {
  return `LK-${Date.now()}-${makeid(4)}`;
}

function statusPath(sessionId) {
  return path.join(ACTIVE_DIR, `${sessionId}.json`);
}

function writeStatus(sessionId, data) {
  ensureDir(ACTIVE_DIR);
  try {
    fs.writeFileSync(statusPath(sessionId), JSON.stringify(data, null, 2));
  } catch (_) {}

  dbUpsert(sessionId, data).catch(() => {});
}

function readStatus(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(sessionId), "utf-8"));
  } catch (_) {
    return null;
  }
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

/* =========================
 * Zip helper
 * ========================= */
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

/* =========================
 * Live sockets
 * ========================= */
const PAIR_SOCKETS = new Map();

function safeEnd(sock) {
  try { sock?.ws?.close?.(); } catch (_) {}
  try { sock?.end?.(); } catch (_) {}
}

/**
 * Request a pairing code with a small retry loop.
 * IMPORTANT: For pairing-code login, the socket usually does NOT reach "open"
 * until AFTER the user links the device. So we must NOT wait for "open" here.
 */
async function requestPairCode(sock, num, tries = 6) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      // Some environments need a short warm-up before requesting.
      await delay(400);
      const code = await sock.requestPairingCode(num);
      if (code) return code;
      lastErr = new Error("Empty pairing code");
    } catch (e) {
      lastErr = e;
      // backoff a bit
      await delay(900 + i * 250);
    }
  }
  throw lastErr || new Error("Failed to request pairing code");
}

/* =========================
 * Core pairing
 * ========================= */
async function startPairing(num) {
  ensureDir(SESS_DIR);

  const session_id = makeSessionId();
  const sessPath = path.join(SESS_DIR, session_id);
  ensureDir(sessPath);

  const created_at = Date.now();
  const ttlMs = 10 * 60 * 1000;
  const expires_at = created_at + ttlMs;

  // initial pending status (no code yet)
  writeStatus(session_id, { status: "pending", created_at, expires_at, phone: num });

  const { state, saveCreds } = await useMultiFileAuthState(sessPath);

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("LORDKARMA Session Portal"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    // very important for pairing-code portals:
    // keep default (mobile false) so it behaves like WhatsApp Web
    mobile: false,
    syncFullHistory: false,
  });

  PAIR_SOCKETS.set(session_id, sock);
  sock.ev.on("creds.update", saveCreds);

  let finalized = false;

  sock.ev.on("connection.update", async (u) => {
    try {
      if (!u) return;

      // When user successfully links, creds.registered becomes true
      if (!finalized && u.connection === "open") {
        // give filesystem a moment to flush creds.json
        await delay(1200);

        if (isRegisteredSession(session_id) || sock?.authState?.creds?.registered) {
          finalized = true;

          const st = readStatus(session_id) || {};
          writeStatus(session_id, { ...st, status: "ready" });

          // Send the welcome message to the linked account (most reliable)
          const me = sock?.user?.id; // e.g. "2348...:xx@s.whatsapp.net"
          const msg =
`🖤✨ LORDKARMA SESSION LINKED ✅

You have successfully linked your bot session.

📌 Session ID:
${session_id}

✅ Next:
Deploy the bot and set SESSION_ID=${session_id}

⚠ Keep this Session ID private.
— LORDKARMA`;

          if (me) {
            await delay(2000);
            try {
              await sock.sendMessage(me, { text: msg });
            } catch (e) {
              console.log("[welcome send failed]", e?.message || e);
            }
          }

          // Keep alive a bit so WhatsApp finishes the link handshake
          await delay(20000);

          safeEnd(sock);
          PAIR_SOCKETS.delete(session_id);
        }
      }

      if (u.connection === "close") {
        PAIR_SOCKETS.delete(session_id);
      }
    } catch (e) {
      console.log("[connection.update error]", e?.message || e);
    }
  });

  // IMPORTANT:
  // For *pairing code* auth, Baileys often won't reach connection === "open" until AFTER
  // the user links the device. So waiting for "open" here can deadlock.
  // Instead, request the pairing code with a small retry loop.
  const code = await requestPairCode(sock, num);

  const st = readStatus(session_id) || {};
  writeStatus(session_id, { ...st, code });

  // TTL cleanup
  setTimeout(() => {
    try {
      const st2 = readStatus(session_id);
      if (st2 && st2.status !== "ready") writeStatus(session_id, { ...st2, status: "expired" });
    } catch (_) {}

    const s = PAIR_SOCKETS.get(session_id);
    if (s) {
      safeEnd(s);
      PAIR_SOCKETS.delete(session_id);
    }
  }, ttlMs).unref?.();

  return { session_id, code, expires_at };
}

/* =========================
 * Routes
 * ========================= */

router.post("/pair", pairLimiter, requireSecret, async (req, res) => {
  try {
    const raw = req.body?.number || req.body?.phone || req.body?.num;
    const num = normalizeNumber(raw);
    if (!num) return res.status(400).json({ ok: false, error: "Invalid phone number" });

    const out = await startPairing(num);
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[api/pair]", e);
    return res.status(500).json({ ok: false, error: e?.message || "Pairing service failed" });
  }
});

// Legacy: GET /api/code?number=...
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

// GET /api/status/:id
router.get("/status/:id", async (req, res) => {
  try {
    const id = req.params.id;

    let st = readStatus(id);
    if (!st) {
      const d = await dbGet(id);
      if (!d) return res.status(404).json({ ok: false, status: "missing" });
      st = { status: d.status, created_at: d.created_at, expires_at: d.expires_at, code: d.code, phone: d.phone };
    }

    // upgrade to ready if creds are registered
    if (st.status !== "ready" && isRegisteredSession(id)) {
      writeStatus(id, { ...st, status: "ready" });
      return res.json({ ok: true, ...readStatus(id) });
    }

    return res.json({ ok: true, ...st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "status failed" });
  }
});

// GET /api/session/:id  -> zip as base64
router.get("/session/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const sessPath = path.join(SESS_DIR, id);
    if (!fs.existsSync(sessPath)) return res.status(404).json({ ok: false, error: "Session not found" });

    // only allow after registered
    if (!isRegisteredSession(id)) {
      return res.status(409).json({ ok: false, error: "Session not ready yet" });
    }

    const zipBuf = await zipFolderToBuffer(sessPath);
    return res.json({ ok: true, session_id: id, zip_base64: zipBuf.toString("base64") });
  } catch (e) {
    console.error("[api/session]", e);
    return res.status(500).json({ ok: false, error: "Failed to package session" });
  }
});

module.exports = router;
