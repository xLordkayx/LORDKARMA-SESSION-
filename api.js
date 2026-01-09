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
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function normalizeNumber(raw) {
  if (!raw) return null;
  const num = String(raw).replace(/[^0-9]/g, "");
  if (num.length < 8) return null;
  return num;
}

/* =========================
 * Secret Gate
 * ========================= */
function checkSecret(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return true;

  const provided = (
    req.headers["x-session-secret"] ||
    req.query?.secret ||
    req.body?.secret ||
    req.body?.password ||
    ""
  ).toString().trim();

  return provided && provided === secret;
}

function requireSecret(req, res, next) {
  if (checkSecret(req)) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)" });
}

/* =========================
 * DB helpers
 * ========================= */
// IMPORTANT: avoid created_at conflict by never putting created_at in $set
async function dbUpsert(session_id, patch) {
  try {
    const col = await getCollection();
    if (!col) return;

    const { created_at, ...safePatch } = patch || {};

    await col.updateOne(
      { session_id },
      {
        $set: { ...safePatch, session_id, updated_at: Date.now() },
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
  } catch {
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
  } catch {}
  dbUpsert(sessionId, data).catch(() => {});
}

function readStatus(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(sessionId), "utf-8"));
  } catch {
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
  } catch {
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
 * Live sockets map
 * ========================= */
const PAIR_SOCKETS = new Map();

/* =========================
 * Core pairing (stable)
 * ========================= */
async function startPairing(num) {
  ensureDir(SESS_DIR);

  const session_id = makeSessionId();
  const sessPath = path.join(SESS_DIR, session_id);
  ensureDir(sessPath);

  const created_at = Date.now();
  const ttlMs = 10 * 60 * 1000;
  const expires_at = created_at + ttlMs;

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

  // 1) Ask WhatsApp for pairing code
  // IMPORTANT: call only when NOT registered (fresh auth)
  let code = null;
  try {
    await delay(1000);
    code = await sock.requestPairingCode(num);
  } catch (e) {
    // mark failed and close
    const st = readStatus(session_id) || {};
    writeStatus(session_id, { ...st, status: "failed", error: "pair_code_failed" });

    try { sock.end?.(); } catch {}
    PAIR_SOCKETS.delete(session_id);

    throw e;
  }

  // store code
  const st0 = readStatus(session_id) || {};
  writeStatus(session_id, { ...st0, code, status: "code_issued" });

  // 2) Confirm READY only when creds become registered
  let readyDone = false;

  sock.ev.on("creds.update", async () => {
    try {
      if (readyDone) return;

      // wait for creds.json write
      await delay(600);

      if (!isRegisteredSession(session_id)) return;

      readyDone = true;

      const st = readStatus(session_id) || {};
      writeStatus(session_id, { ...st, status: "ready" });

      // Try welcome message
      const jid = `${num}@s.whatsapp.net`;
      const msg =
`🖤✨ LORDKARMA SESSION LINKED ✅

You have successfully linked your bot session.

📌 Session ID:
${session_id}

⚠ Keep this Session ID private.
— LORDKARMA`;

      // Give WA Web time to stabilize
      await delay(2500);
      try { await sock.sendMessage(jid, { text: msg }); } catch {}

      // Keep alive briefly (prevents “couldn’t link device” for some accounts)
      await delay(15000);

      try { sock.end?.(); } catch {}
      PAIR_SOCKETS.delete(session_id);
    } catch {}
  });

  // 3) TTL cleanup
  setTimeout(() => {
    try {
      const st2 = readStatus(session_id);
      if (st2 && st2.status !== "ready") {
        writeStatus(session_id, { ...st2, status: "expired" });
      }
    } catch {}

    const s = PAIR_SOCKETS.get(session_id);
    if (s) {
      try { s.end?.(); } catch {}
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
    console.error("[api/pair]", e?.message || e);
    return res.status(500).json({ ok: false, error: "Pairing service failed" });
  }
});

router.get("/code", async (req, res) => {
  try {
    const num = normalizeNumber(req.query?.number);
    if (!num) return res.status(400).json({ code: "Invalid number" });

    const out = await startPairing(num);
    return res.json({ code: out.code, session_id: out.session_id, expires_at: out.expires_at });
  } catch (e) {
    console.error("[api/code]", e?.message || e);
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
        error: d.error,
      };
    }

    // upgrade to ready if creds are registered
    if (st.status !== "ready" && isRegisteredSession(id)) {
      writeStatus(id, { ...st, status: "ready" });
      return res.json({ ok: true, ...readStatus(id) });
    }

    return res.json({ ok: true, ...st });
  } catch {
    return res.status(500).json({ ok: false, error: "status failed" });
  }
});

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
    console.error("[api/session]", e?.message || e);
    return res.status(500).json({ ok: false, error: "Failed to package session" });
  }
});

module.exports = router;
