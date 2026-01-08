
const express = require('express');
const router = express.Router();

// Allow browser clients (you can restrict origins via CORS_ORIGIN env)
router.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET','POST'], allowedHeaders: ['Content-Type','X-SESSION-SECRET'] }));

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
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
const { getCollection } = require('./db');

const pino = require("pino");
const { makeid } = require('./id');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  delay,
  Browsers
} = require("maher-zubair-baileys");

// Sessions are stored on disk.
// NOTE: Vercel filesystem is ephemeral. For reliable persistence, deploy on Render.
const SESS_DIR = path.join(process.cwd(), 'sessions');
const ACTIVE_DIR = path.join(process.cwd(), 'active'); // status + expiries

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

function normalizeNumber(raw){
  if(!raw) return null;
  const num = String(raw).replace(/[^0-9]/g,'');
  if(num.length < 8) return null;
  return num;
}

function checkSecret(req){
  const secret = process.env.SESSION_SECRET;
  if(!secret) return true; // disabled
  const provided = (req.headers['x-session-secret'] || req.query?.secret || req.body?.secret || req.body?.password || '').toString();
  return provided && provided === secret;
}

function requireSecret(req, res, next){
  if(checkSecret(req)) return next();
  return res.status(401).json({ ok:false, error:'Unauthorized (bad secret)' });
}

async function dbUpsert(session_id, patch){
  try{
    const col = await getCollection();
    if(!col) return;
    await col.updateOne(
      { session_id },
      { $set: { ...patch, session_id, updated_at: Date.now() }, $setOnInsert: { created_at: patch.created_at || Date.now() } },
      { upsert: true }
    );
  } catch(e){
    console.warn('[dbUpsert]', e?.message || e);
  }
}

async function dbGet(session_id){
  try{
    const col = await getCollection();
    if(!col) return null;
    return await col.findOne({ session_id });
  } catch(e){
    return null;
  }
}


function makeSessionId(){
  const ts = Date.now();
  return `LK-${ts}-${makeid(4)}`;
}

function statusPath(sessionId){
  return path.join(ACTIVE_DIR, `${sessionId}.json`);
}

function writeStatus(sessionId, data){
  ensureDir(ACTIVE_DIR);
  fs.writeFileSync(statusPath(sessionId), JSON.stringify(data, null, 2));
  // mirror to DB when available
  dbUpsert(sessionId, data).catch(()=>{});
}

function readStatus(sessionId){
  try { return JSON.parse(fs.readFileSync(statusPath(sessionId), 'utf-8')); }
  catch(_) { return null; }
}

async function readStatusAny(sessionId){
  const f = readStatus(sessionId);
  if(f) return f;
  const d = await dbGet(sessionId);
  if(!d) return null;
  // normalize fields
  return {
    status: d.status,
    created_at: d.created_at,
    expires_at: d.expires_at,
    code: d.code,
    phone: d.phone
  };
}

function hasCreds(sessionId){
  const dir = path.join(SESS_DIR, sessionId);
  return fs.existsSync(path.join(dir, 'creds.json'));
}

async function zipFolderToBuffer(folderPath){
  return await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('warning', (err) => console.warn('[zip warning]', err?.message || err));
    archive.on('error', reject);
    archive.on('data', (d) => chunks.push(d));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.directory(folderPath, false);
    archive.finalize();
  });
}

// In-memory map for live pairing sockets
const PAIR_SOCKETS = new Map();

async function startPairing(num){
  ensureDir(SESS_DIR);

  const session_id = makeSessionId();
  const sessPath = path.join(SESS_DIR, session_id);
  ensureDir(sessPath);

  const ttlMs = 10 * 60 * 1000; // 10 minutes
  const expires_at = Date.now() + ttlMs;

  writeStatus(session_id, { status:'pending', created_at: Date.now(), expires_at, phone: num });
  await dbUpsert(session_id, { status:'pending', created_at: Date.now(), expires_at, phone: num });

  const { state, saveCreds } = await useMultiFileAuthState(sessPath);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("LORDKARMA Session Portal"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    }
  });

  PAIR_SOCKETS.set(session_id, sock);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    try {
      const { connection } = u || {};
      if(connection === 'open'){
        // creds should exist now
        writeStatus(session_id, { status:'ready', created_at: Date.now(), expires_at });
        await delay(1500);
        try { sock.ws?.close(); } catch(_) {}
        try { sock.end?.(); } catch(_) {}
        PAIR_SOCKETS.delete(session_id);
      } else if(connection === 'close'){
        PAIR_SOCKETS.delete(session_id);
      }
    } catch(e){
      console.log('[connection.update error]', e?.message || e);
    }
  });

  // Request pairing code
  await delay(800);
  const code = await sock.requestPairingCode(num);
  try{ await dbUpsert(session_id, { code }); }catch(_){}
  try{ const st0 = readStatus(session_id) || {}; writeStatus(session_id, { ...st0, code }); }catch(_){}

  // Auto cleanup after TTL
  setTimeout(() => {
    try {
      const st = readStatus(session_id);
      if(st && st.status !== 'ready'){
        writeStatus(session_id, { ...st, status:'expired' });
      }
    } catch(_) {}

    const s = PAIR_SOCKETS.get(session_id);
    if(s){
      try { s.ws?.close(); } catch(_) {}
      try { s.end?.(); } catch(_) {}
      PAIR_SOCKETS.delete(session_id);
    }
  }, ttlMs).unref?.();

  return { session_id, code, expires_at };
}

/**
 * POST /api/pair
 * body: { number: "2348..." }
 */
router.post('/pair', pairLimiter, requireSecret, async (req, res) => {
  try {
    const raw = req.body?.number || req.body?.phone || req.body?.num;
    const num = normalizeNumber(raw);
    if(!num) return res.status(400).json({ ok:false, error:'Invalid phone number' });

    const out = await startPairing(num);
    return res.json({ ok:true, ...out });
  } catch (e) {
    console.error('[api/pair]', e);
    return res.status(500).json({ ok:false, error:'Pairing service failed' });
  }
});

/**
 * Legacy: GET /api/code?number=...
 * returns: { code, session_id, expires_at }
 */
router.get('/code', async (req, res) => {
  try {
    const num = normalizeNumber(req.query?.number);
    if(!num) return res.status(400).json({ code:'Invalid number' });

    const out = await startPairing(num);
    return res.json({ code: out.code, session_id: out.session_id, expires_at: out.expires_at });
  } catch (e) {
    console.error('[api/code]', e);
    return res.status(500).json({ code:'Service Unavailable' });
  }
});

/**
 * GET /api/status/:id
 */
router.get('/status/:id', (req,res) => {
  const id = req.params.id;
  const st = readStatus(id);
  if(!st) return res.status(404).json({ ok:false, status:'missing' });

  // If files exist, force ready
  if(st.status !== 'ready' && hasCreds(id)){
    writeStatus(id, { ...st, status:'ready' });
    return res.json({ ok:true, ...readStatus(id) });
  }
  return res.json({ ok:true, ...st });
});

/**
 * GET /api/session/:id
 * returns: { ok:true, session_id, zip_base64 }
 */
router.get('/session/:id', async (req,res) => {
  try {
    const id = req.params.id;
    const db = await dbGet(id);
    if(db && db.zip_base64){
      // ready from DB
      return res.json({ ok:true, session_id:id, zip_base64: db.zip_base64 });
    }

    const sessPath = path.join(SESS_DIR, id);
    if(!fs.existsSync(sessPath)) return res.status(404).json({ ok:false, error:'Session not found' });
    if(!hasCreds(id)) return res.status(409).json({ ok:false, error:'Session not ready yet' });

    const zipBuf = await zipFolderToBuffer(sessPath);
    return res.json({ ok:true, session_id:id, zip_base64: zipBuf.toString('base64') });
  } catch(e){
    console.error('[api/session]', e);
    return res.status(500).json({ ok:false, error:'Failed to package session' });
  }
});

module.exports = router;
