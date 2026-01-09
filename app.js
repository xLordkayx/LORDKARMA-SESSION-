
/* LORDKARMA Session Generator - Express App (shared by Render/Vercel) */

const express = require('express');
const bodyParser = require("body-parser");
const path = require('path');

const app = express();
const __path = process.cwd();

require('events').EventEmitter.defaultMaxListeners = 500;

// Render/Reverse proxies set X-Forwarded-For.
// Needed so express-rate-limit can correctly identify clients.
app.set('trust proxy', 1);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const api = require('./api');
app.use('/api', api);

app.get('/pair', (req, res) => res.sendFile(path.join(__path, 'pair.html')));
app.get('/', (req, res) => res.sendFile(path.join(__path, 'index.html')));

try {
  const qr = require('./qr');
  app.use('/qr', qr);
} catch (_) {}

app.get('/code', (req, res) => {
  req.url = '/code' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return api(req, res, () => {});
});

module.exports = app;
