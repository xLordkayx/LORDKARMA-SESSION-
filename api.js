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

/** =========================
 *  Secret gate
 *  ========================= */

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

  dbUpsert(sessionId, data).catch(() => {});
}

function readStatus(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(sessionId), "utf-8"));
  } catch (_) {
    return null;
  }
}
function isRegisteredSession(sessionId) {
  const credsPath = path.join(SESS_DIR, sessionId, "creds.json");
  if (!fs.existsSync(credsPath)) return false;

  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return !!creds.registered; // ✅ only true after successful link
  } catch {
    return false;
  }
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
  const ttlMs = 10 * 60 * 1000;
  const expires_at = created_at + ttlMs;

  writeStatus(session_id, {
    status: "pending",
    created_at,
    expires_at,
    phone: num
  });

  const { state, saveCreds } = await useMultiFileAuthState(sessPath);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("LORDKARMA Portal"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
    }
  });

  PAIR_SOCKETS.set(session_id, sock);
  sock.ev.on("creds.update", saveCreds);

  // 🔒 DO NOT TOUCH SOCKET UNTIL REGISTERED
  sock.ev.on("connection.update", async (u) => {
    if (u.connection === "open") {
      const credsPath = path.join(sessPath, "creds.json");
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));

      if (creds?.registered) {
        writeStatus(session_id, {
          status: "ready",
          created_at,
          expires_at,
          phone: num
        });

        // send welcome message
        const jid = `${num}@s.whatsapp.net`;
        await delay(3000);
        await sock.sendMessage(jid, {
          text: `🖤 LORDKARMA SESSION LINKED\n\nSession ID:\n${session_id}\n\nKeep this safe.`
        });

        await delay(15000);
        sock.end();
        PAIR_SOCKETS.delete(session_id);
      }
    }
  });

  // WAIT for WhatsApp to give us the pairing code
  await delay(1200);
  

  writeStatus(session_id, {
    status: "pending",
    created_at,
    expires_at,
    phone: num,
    code
  });

  return { session_id, code, expires_at };
}

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

  // Listen for successful registration before marking ready
  let readyDone = false;

  sock.ev.on("connection.update", async (u) => {
    try {
      const { connection } = u || {};

      // Only mark ready when creds are actually registered
      if (!readyDone && connection === "open") {
        const registered =
          sock?.authState?.creds?.registered ||
          state?.creds?.registered ||
          false;

        if (registered && hasCreds(session_id)) {
          readyDone = true;

          const st = readStatus(session_id) || {};
          writeStatus(session_id, { ...st, status: "ready" });

          // Send WhatsApp welcome ONLY after confirmed ready
          const jid = `${num}@s.whatsapp.net`;
          const msg =
`🖤✨ LORDKARMA SESSION LINKED ✅

You have successfully linked your bot session.

📌 Session ID:
${session_id}

⚠ Keep this Session ID private.
— LORDKARMA`;

          await delay(2500);
          try {
            await sock.sendMessage(jid, { text: msg });
          } catch (e) {
            console.log("[welcome send failed]", e?.message || e);
          }
          if (connection === "open" && isRegisteredSession(session_id)) {
  // mark ready + send welcome
          }

          // Keep alive briefly to avoid link failure
          await delay(8000);

          try { sock.ws?.close(); } catch {}
          try { sock.end?.(); } catch {}
          PAIR_SOCKETS.delete(session_id);
        }
      }

      if (connection === "close") {
        PAIR_SOCKETS.delete(session_id)
      }
    } catch (e) {
      console.log("[connection.update error]", e?.message || e);
    }
  });

  // Request pairing code (this is the actual pairing code)
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
      try { s.ws?.close(); } catch (_) {}
      try { s.end?.(); } catch (_) {}
      PAIR_SOCKETS.delete(session_id);
    }
  }, ttlMs).unref?.();

  return { session_id, code, expires_at };
}

/** =========================
 *  Routes
 *  ========================= */

router.post("/pair", pairLimiter, requireSecret, async (req, res) => {
  try {
    const raw = req.body?.number || req.body?.phone || req.body?.num;
    const num = normalizeNumber(raw);
    if (!num)
      return res
        .status(400)
        .json({ ok: false, error: "Invalid phone number" });

    const out = await startPairing(num);
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[api/pair]", e);
    return res.status(500).json({ ok: false, error: "Pairing service failed" });
  }
});

router.get("/code", async (req, res) => {
  try {
    const num = normalizeNumber(req.query?.number);
    if (!num) return res.status(400).json({ code: "Invalid number" });

    const out = await startPairing(num);
    return res.json({
      code: out.code,
      session_id: out.session_id,
      expires_at: out.expires_at,
    });
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
  writeStatus(id, { ...st, status: "ready" });
  return res.json({ ok: true, ...readStatus(id) });
                                                     }

    return res.json({ ok: true, ...st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "status failed" });
  }
});

router.get("/session/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const db = await dbGet(id);
    if (db && db.zip_base64) {
      return res.json({ ok: true, session_id: id, zip_base64: db.zip_base64 });
    }

    const sessPath = path.join(SESS_DIR, id);
    if (!fs.existsSync(sessPath))
      return res.status(404).json({ ok: false, error: "Session not found" });

    if (!isRegisteredSession(id)) {
  return res.status(409).json({ ok:false, error:"Session not ready yet" });
                           }

    const zipBuf = await zipFolderToBuffer(sessPath);
    return res.json({
      ok: true,
      session_id: id,
      zip_base64: zipBuf.toString("base64"),
    });
  } catch (e) {
    console.error("[api/session]", e);
    return res.status(500).json({ ok: false, error: "Failed to package session" });
  }
});

module.exports = router;
