'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return 'nao definido';
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

function createPairingServer(options = {}) {
  const {
    app,
    getRuntimeState = null,
    port = Number(process.env.PORT || 3000),
    host = '0.0.0.0',
    enabled = isTrue(process.env.WEB_PAIRING_ENABLED || 'true'),
    username = String(process.env.WEB_PAIRING_USER || 'admin').trim(),
    password = String(process.env.WEB_PAIRING_PASSWORD || process.env.DASHBOARD_PASSWORD || '').trim(),
  } = options;

  if (!enabled) {
    console.log('[Web] Pareamento por dominio desativado (WEB_PAIRING_ENABLED=false).');
    return {
      start: async () => null,
      stop: async () => null,
    };
  }

  if (!app || typeof app.getStatus !== 'function') {
    throw new Error('createPairingServer requer instancia valida do WhatsAppClient.');
  }

  const publicDir = path.join(__dirname, 'public');
  const indexFile = path.join(publicDir, 'index.html');

  function unauthorized(res) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Pairing"',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  function isAuthorized(req) {
    if (!password) return true;

    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Basic ')) return false;

    const encoded = authHeader.slice(6).trim();
    let decoded = '';
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch (_) {
      return false;
    }

    const separator = decoded.indexOf(':');
    if (separator < 0) return false;

    const user = decoded.slice(0, separator);
    const pass = decoded.slice(separator + 1);
    return user === username && pass === password;
  }

  function getPairingSnapshot() {
    const status = app.getStatus();
    const runtimeState = typeof getRuntimeState === 'function' ? (getRuntimeState() || {}) : {};
    return {
      ok: true,
      ready: !!status.ready,
      qrGenerated: !!status.qrGenerated,
      qrData: app.getQRData() || '',
      pairingCode: typeof app.getPairingCode === 'function' ? String(app.getPairingCode() || '') : '',
      pairingPhoneMasked:
        typeof app.getPairingPhoneMasked === 'function'
          ? app.getPairingPhoneMasked()
          : maskPhone(process.env.PAIRING_PHONE_NUMBER || ''),
      bootPhase: String(runtimeState.phase || 'starting'),
      bootError: String(runtimeState.error || ''),
      timestamp: new Date().toISOString(),
    };
  }

  const server = http.createServer((req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const url = String(req.url || '/').split('?')[0];

    // Keep a public health endpoint for platform health checks.
    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Root stays public to avoid failing default health checks.
    if (method === 'GET' && url === '/') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, service: 'pairing', path: '/pairing' }));
      return;
    }

    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }

    if (method === 'GET' && url === '/pairing') {
      let html = '';
      try {
        html = fs.readFileSync(indexFile, 'utf8');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Falha ao carregar interface: ${err.message}`);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (method === 'GET' && url === '/api/pairing') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(getPairingSnapshot()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  return {
    start: async () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          console.log(`[Web] Interface de pareamento ativa em http://${host}:${port}/pairing`);
          if (password) {
            console.log(`[Web] Autenticacao basica ativa (user: ${username}).`);
          } else {
            console.warn('[Web] WEB_PAIRING_PASSWORD nao definida. Endpoint publico sem senha.');
          }
          resolve(server);
        });
      }),
    stop: async () =>
      new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }

        server.close(() => {
          console.log('[Web] Interface de pareamento encerrada.');
          resolve();
        });
      }),
  };
}

module.exports = {
  createPairingServer,
};
