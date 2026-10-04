/**
 * CRISP AND CLOUD — WhatsApp order bridge
 * ------------------------------------------------------------------
 * Node.js + Baileys service that:
 *   1. Exposes a pairing QR the admin scans from
 *      WhatsApp > Settings > Linked Devices.
 *   2. Listens for new orders coming from the admin panel and pushes a
 *      beautifully formatted message (with a Google Maps location link)
 *      to the restaurant's WhatsApp number.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /api/whatsapp/status          connection state + live pairing QR
 *   GET  /api/whatsapp/qr.png          pairing QR as a PNG image
 *   GET  /api/whatsapp/chat-link       wa.me deep link to the owner
 *   GET  /api/whatsapp/qr-chat.png     wa.me deep link as a PNG image
 *   POST /api/whatsapp/test            send a sample message to the owner
 *   POST /api/whatsapp/send-order      send a real order
 *   POST /api/whatsapp/logout          unlink the device
 *   GET  /api/health                   liveness probe
 */

import express from 'express';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser,
} from 'baileys';
import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normaliseToInternational, formatPhoneDisplay } from './phone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ─── Configuration ──────────────────────────────────────────────── */

const PORT = Number(process.env.PORT || 3000);
const SITE_PORT = Number(process.env.SITE_PORT || 8080);

/**
 * Start the customer-facing static site from the same origin as the bridge.
 * The PWA and the WhatsApp bridge now share one public URL (one Render
 * web service), so the admin panel can reach /api/* and /api/whatsapp/QR
 * while users open the menu, login, and place orders from the same host.
 */
import http from 'node:http';

function serveSite() {
  const site = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400); return res.end('Bad request');
    }
    if (pathname === '/') pathname = '/index.html';

    // Resolve inside ROOT and confirm it did not escape via ../ or an absolute path.
    const target = path.resolve(ROOT, '.' + pathname);

    // Refuse anything inside server/ — it holds auth credentials and node_modules.
    const relToServer = path.relative(path.join(ROOT, 'server'), target);
    const insideServer = relToServer === '' ||
      (!relToServer.startsWith('..') && !path.isAbsolute(relToServer));

    const escapesRoot = target !== ROOT && !target.startsWith(ROOT + path.sep);

    if (insideServer || escapesRoot) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('403 Forbidden — server/ is not served');
    }

    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(target).pipe(res);
    });
  });

  site.listen(SITE_PORT, () => {
    console.log(`🍽️  CRISP AND CLOUD website running at  http://localhost:${SITE_PORT}`);
    console.log(`      Bridge API       ->  http://localhost:${PORT} (WhatsApp alerts)`);
    console.log(`      Website          ->  http://localhost:${SITE_PORT}`);
    console.log(`      One process = one public URL: ${PORT} + ${SITE_PORT}`);
  });

  return site;
}

/** The owner number in full international form, e.g. 919058767686. */
const OWNER_NUMBER = normaliseToInternational(process.env.WA_OWNER_NUMBER || '9058767686');
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '.wa-session');
/**
 * Optional shared secret. When set, every /api call must send it in the
 * `x-api-key` header. Leave unset for local-only development.
 */
const API_KEY = process.env.WA_API_KEY || '';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'info' });

/* ─── Order message formatting ───────────────────────────────────── */

const RUPEE = '₹';
const WIDTH = 34;

/** Pad a label to a fixed column width so the block aligns in WhatsApp. */
function row(label, value, width = WIDTH) {
  const gap = Math.max(1, width - label.length - String(value).length);
  return `${label}${' '.repeat(gap)}${value}`;
}

/** Repeat a character to the block width. */
function rule(char = '─', width = WIDTH) {
  return char.repeat(width);
}

function money(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return `${RUPEE}0`;
  return `${RUPEE}${num.toFixed(2).replace(/\.00$/, '')}`;
}

/** Build the Google Maps link for an order's coordinates. */
export function buildMapsLink(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0)) return '';
  return `https://www.google.com/maps/search/?api=1&query=${la},${ln}`;
}

/** Turn a Firestore timestamp / ISO string into a readable local stamp. */
function formatDate(value) {
  if (!value) return 'Just now';
  let d;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    d = value.toDate();               // Firestore Timestamp
  } else if (typeof value === 'object' && typeof value.seconds === 'number') {
    d = new Date(value.seconds * 1000);
  } else if (typeof value === 'number') {
    d = new Date(value);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/**
 * Build the full WhatsApp message for an order.
 * Uses WhatsApp's *bold* / ```mono``` markup plus box-drawing rules
 * so it reads as a tidy "form" in the chat bubble.
 */
export function buildOrderMessage(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = [];

  lines.push('╭───────────────────────────────╮');
  lines.push('   🍽️  *NEW ORDER RECEIVED*');
  lines.push('╰───────────────────────────────╯');
  lines.push('');

  // ── Order meta ──────────────────────────────────────────────
  lines.push(`*📋 ORDER DETAILS*`);
  lines.push(rule());
  const shortId = String(order.id || '—').slice(0, 8).toUpperCase();
  lines.push(row('Order ID', `#${shortId}`));
  lines.push(row('Received', formatDate(order.createdAt)));
  lines.push(row('Payment', String(order.paymentMethod || 'cod').toUpperCase() === 'COD' ? 'Cash on Delivery' : (order.paymentMethod || 'Cash on Delivery')));
  lines.push(row('Items', `${items.reduce((n, i) => n + (Number(i.qty) || 0), 0)}`));
  lines.push('');

  // ── Customer ────────────────────────────────────────────────
  lines.push(`*👤 CUSTOMER*`);
  lines.push(rule());
  lines.push(row('Name', order.userName || 'Customer'));
  if (order.userPhone && order.userPhone !== 'N/A') {
    const intl = normaliseToInternational(order.userPhone);
    lines.push(row('Phone', formatPhoneDisplay(order.userPhone)));
    if (intl) lines.push(row('WhatsApp', `https://wa.me/${intl}`));
  }
  lines.push('');

  // ── Items ───────────────────────────────────────────────────
  lines.push(`*🛒 ORDERED ITEMS*`);
  lines.push(rule());
  if (items.length === 0) {
    lines.push('(no items)');
  } else {
    items.forEach((item, idx) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      const lineTotal = qty * price;
      lines.push(`${idx + 1}. *${item.name || 'Item'}*`);
      const qtyLabel = `   Qty ${qty} × ${money(price)}`;
      lines.push(`${qtyLabel}${' '.repeat(Math.max(1, WIDTH - qtyLabel.length - String(money(lineTotal)).length))}${money(lineTotal)}`);
      if (item.deliveryTime) lines.push(`   ⏱ ${item.deliveryTime}`);
    });
  }
  lines.push('');

  // ── Bill ────────────────────────────────────────────────────
  lines.push(`*💰 BILL SUMMARY*`);
  lines.push(rule());
  const sub = Number(order.subtotal) || items.reduce((n, i) => n + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const del = Number(order.deliveryCharge) || 0;
  lines.push(row('Subtotal', money(sub)));
  lines.push(row('Delivery', del > 0 ? money(del) : 'FREE'));
  lines.push('─'.repeat(WIDTH - 8));
  lines.push(row('*TOTAL*', `*${money(Number(order.total) || (sub + del))}*`));
  lines.push('');

  // ── Delivery location ───────────────────────────────────────
  lines.push(`*📍 DELIVERY LOCATION*`);
  lines.push(rule());
  const address = order.address || '(not provided)';
  // Wrap long addresses so nothing spills out of the bubble.
  const addrWords = String(address).split(/\s+/);
  let line = '';
  for (const w of addrWords) {
    if ((line + ' ' + w).trim().length > WIDTH) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  lines.push('');

  const mapsLink = buildMapsLink(order.lat, order.lng);
  if (mapsLink) {
    lines.push(`*Open in Google Maps:*`);
    lines.push(mapsLink);
    lines.push('');
  }

  lines.push(rule('═'));
  lines.push('_Sent by CRISP AND CLOUD order system_');
  lines.push(`_Order ref: ${shortId}_`);

  return lines.join('\n');
}

/** Build the sample/test message. */
export function buildTestMessage() {
  return [
    '╭───────────────────────────────╮',
    '   ✅  *WHATSAPP CONNECTED*',
    '╰───────────────────────────────╯',
    '',
    'You will receive a detailed message here',
    'every time a new order comes in, with:',
    '',
    `${rule()}`,
    '• Full customer details',
    '• Every ordered item with qty',
    '• Bill summary and total',
    '• Delivery address',
    '• A tap-to-open Google Maps link',
    `${rule()}`,
    '',
    `Connected at: ${formatDate(new Date().toISOString())}`,
  ].join('\n');
}

/* ─── WhatsApp connection ───────────────────────────────────────── */

let sock = null;
let qrText = null;
let connectionState = 'disconnected';
let lastError = null;
let connectedNumber = null;

/** Serialise sends — Baileys drops concurrent sends on the same socket. */
let sendChain = Promise.resolve();
function enqueue(task) {
  sendChain = sendChain.then(task, task);
  return sendChain;
}

async function startWhatsApp() {
  if (sock) return;

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Using WhatsApp web version');

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),        // Baileys is very chatty
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['CRISP AND CLOUD', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrText = qr;
      connectionState = 'awaiting_scan';
      logger.info('Pairing QR generated — scan it from the admin panel.');
    }

    if (connection === 'open') {
      connectionState = 'connected';
      qrText = null;
      lastError = null;
      try {
        const me = jidNormalizedUser(sock.user.id);
        connectedNumber = me.replace(/\D/g, '');
        logger.info({ connectedNumber }, 'WhatsApp connected');
      } catch {
        connectedNumber = null;
      }
    }

    if (connection === 'close') {
      qrText = null;
      connectedNumber = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      connectionState = statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected';
      lastError = lastDisconnect?.error?.message || 'Connection closed';
      logger.warn({ statusCode, lastError }, 'WhatsApp disconnected');

      sock = null;
      if (statusCode !== DisconnectReason.loggedOut) {
        // Reconnect automatically, but back off a little.
        setTimeout(startWhatsApp, 5000);
      } else {
        logger.warn('Logged out — scan a new QR to relink.');
      }
    }
  });

  sock.ev.on('error', (err) => {
    lastError = err?.message || String(err);
    logger.error({ err: lastError }, 'WhatsApp socket error');
  });
}

/* ─── HTTP API ──────────────────────────────────────────────────── */

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ─── Static site (SPA) ─── */
// Serve the customer-facing PWA from this same origin. The front-end is
// plain static files (index.html, manifest.json, logo.png, images); the
// server only ever serves them plus its own /api so one process = one port.

const __file = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__file), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ✅ CORRECT ORDER: register all /api routes FIRST, so they are never
// swallowed by a generic SPA catch-all. The CORS middleware below applies
// globally *after* the API routes, so it cannot shadow them.

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, state: connectionState });
});

app.get('/api/whatsapp/status', requireKey, async (_req, res) => {
  let qrPng = null;
  if (qrText) {
    try {
      qrPng = await QRCode.toDataURL(qrText, { width: 320, margin: 2 });
    } catch (e) {
      logger.error({ e: e.message }, 'QR render failed');
    }
  }
  res.json({
    ok: true,
    state: connectionState,
    connectedNumber,
    owner: OWNER_NUMBER,                 // 919058767686
    ownerDisplay: formatPhoneDisplay(OWNER_NUMBER),   // +91 90587 67686
    ownerJid: OWNER_JID,
    hasQr: Boolean(qrText),
    qrDataUrl: qrPng,
    lastError,
  });
});

app.get('/api/whatsapp/qr.png', requireKey, async (_req, res) => {
  if (!qrText) return res.status(404).json({ ok: false, error: 'No QR available' });
  try {
    const png = await QRCode.toBuffer(qrText, { width: 640, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/whatsapp/chat-link', requireKey, (req, res) => {
  const text = req.query.text ? String(req.query.text) : 'Hello! New order alert.';
  res.json({ ok: true, link: chatLink(text), ownerDisplay: formatPhoneDisplay(OWNER_NUMBER) });
});

app.get('/api/whatsapp/qr-chat.png', requireKey, async (req, res) => {
  const text = req.query.text ? String(req.query.text) : 'Hello! New order alert.';
  try {
    const png = await QRCode.toBuffer(chatLink(text), { width: 640, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/whatsapp/test', requireKey, async (req, res) => {
  if (!canSend(res)) return;
  try {
    const message = buildTestMessage();
    await enqueue(() => sock.sendMessage(OWNER_JID, { text: message }));
    res.json({ ok: true, message: 'Test message sent' });
  } catch (e) {
    logger.error({ e: e.message }, 'Test send failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/whatsapp/send-order', requireKey, async (req, res) => {
  if (!canSend(res)) return;
  try {
    const order = req.body?.order || req.body || {};
    const message = buildOrderMessage(order);
    await enqueue(() =>
      sock.sendMessage(OWNER_JID, {
        text: message,
        mentions: [],
      })
    );
    logger.info({ orderId: order.id }, 'Order notification sent');
    res.json({ ok: true, message: 'Order sent to WhatsApp' });
  } catch (e) {
    logger.error({ e: e.message }, 'Order send failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/whatsapp/logout', requireKey, async (_req, res) => {
  try {
    if (sock) await sock.logout();
    // Nuke the stored credentials so the next connect asks for a fresh QR.
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
    sock = null;
    qrText = null;
    connectionState = 'disconnected';
    connectedNumber = null;
    res.json({ ok: true, message: 'Logged out. Reload to get a new QR.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Preview helper (no WhatsApp needed) ────────────────────────
// SPA routes and static files. Come LAST so they never shadow /api endpoints.

// Block the server/ directory itself (it holds auth credentials).
app.use((req, res, next) => {
  const raw = req.originalUrl;
  if (raw.startsWith('/server/') || raw.startsWith('/node_modules/') || raw.startsWith('/.') ||
      raw.startsWith('/package-lock.json') || raw.startsWith('/package.json')) {
    return res.status(404).end();
  }
  next();
});

app.use((req, res, next) => {
  const raw = req.originalUrl;
  if (raw === '/config' || raw === '/firebase-config.js') {
    // Read-only cloud config.
    return res.sendFile(path.join(ROOT, 'firebase-config.js'));
  }
  next();
});

// Default pages (/{deep-link}) must be caught after /api, before static files.
app.use((req, res, next) => {
  const raw = req.originalUrl;
  if (raw === '/' || raw === '') {
    return res.sendFile(path.join(ROOT, 'index.html'));
  }
  next();
});

// Static assets under /static/[name].[ext].
app.use('/static', express.static(ROOT, { fallthrough: false }));

/** Reject requests that don't carry the shared secret (when configured). */
function requireKey(req, res, next) {
  if (!API_KEY) return next();                    // dev mode: open
  if (req.get('x-api-key') === API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
}

serveSite();

app.listen(PORT, () => {
  logger.info(`WhatsApp bridge listening on http://localhost:${PORT}`);
  logger.info(`Order alerts will be delivered to WhatsApp ${formatPhoneDisplay(OWNER_NUMBER)} (JID ${OWNER_JID})`);
  startWhatsApp().catch((e) => logger.error({ e: e.message }, 'Failed to start WhatsApp'));
});