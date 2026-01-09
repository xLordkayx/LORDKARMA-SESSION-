/* LORDKARMA Session Generator - Express App (Render/Vercel) */
"use strict";

const express = require("express");
const path = require("path");

require("events").EventEmitter.defaultMaxListeners = 500;

const app = express();
const ROOT = process.cwd();

// Render/Vercel sit behind a proxy. Needed for express-rate-limit + correct IPs.
app.set("trust proxy", 1);

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// API
const apiRouter = require("./api");
app.use("/api", apiRouter);

// Pages
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/pair", (req, res) => res.sendFile(path.join(ROOT, "pair.html")));

// Optional QR route (if present)
try {
  const qr = require("./qr");
  app.use("/qr", qr);
} catch (_) {}

// Legacy compatibility: /code -> /api/code
app.get("/code", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(302, "/api/code" + qs);
});

module.exports = app;
