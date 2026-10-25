import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

if (!process.env.PORT && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

import { getDatabase, runMigrations } from '../packages/db/src/index.js';
import { createPaymentApp } from '../apps/payment-api/src/index.js';
import { AdminServer } from '../apps/merchant-admin/src/server.js';
import { CheckoutServer } from '../apps/checkout-portal/src/server.js';

if (!process.env.YOUPI_PUBLIC_URL && process.env.RENDER_EXTERNAL_URL) {
  process.env.YOUPI_PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;
}
const PORT = Number(process.env.PORT || process.env.PAYMENT_API_PORT || 10000);
const HOST = process.env.YOUPI_BIND_HOST || '0.0.0.0';

console.log('====================================================');
console.log('🚀 Starting YOUPI PG All-in-One Cloud Server');
console.log('====================================================');

const db = getDatabase();
const { defaultMerchant } = runMigrations(db);
console.log(`[✓] Database initialized. Default merchant: ${defaultMerchant?.businessName || 'Default'}`);

const paymentApp = createPaymentApp(db);
const paymentServer = paymentApp.rawServer;

const adminServerInstance = new AdminServer({
  db,
  apiBaseUrl: `http://127.0.0.1:${PORT}`
});
const adminServer = adminServerInstance.createServer();

const checkoutServerInstance = new CheckoutServer({
  apiBaseUrl: `http://127.0.0.1:${PORT}`
});
const checkoutServer = checkoutServerInstance.createServer();

const masterServer = http.createServer((req, res) => {
  let pathname = '/';
  try {
    const parsed = new URL(req.url, 'http://localhost');
    pathname = parsed.pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed request URL' }));
    return;
  }

  // 1. Unified 24/7 Health Check (supports both GET and HEAD for UptimeRobot)
  if (pathname === '/health' || pathname === '/api/v1/health' || pathname === '/ping') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method.toUpperCase() === 'HEAD') {
      res.end();
      return;
    }
    res.end(JSON.stringify({
      status: 'UP',
      service: 'youpi-cloud-gateway',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 2. Customer Checkout Portal & Checkout SDK / assets
  if (
    pathname.startsWith('/checkout') ||
    pathname === '/youpi.js' ||
    pathname.startsWith('/sdk/') ||
    pathname.startsWith('/icons/')
  ) {
    checkoutServer.emit('request', req, res);
    return;
  }

  // 3. Core Payment API routes
  if (
    pathname.startsWith('/api/v1/') ||
    pathname.startsWith('/api/poller') ||
    pathname.startsWith('/api/device') ||
    pathname.startsWith('/api/customer')
  ) {
    paymentServer.emit('request', req, res);
    return;
  }

  // 4. Merchant Admin Panel & Control Center (Default for /, /admin, admin assets)
  adminServer.emit('request', req, res);
});

masterServer.on('upgrade', (req, socket, head) => {
  paymentServer.emit('upgrade', req, socket, head);
});

masterServer.listen(PORT, HOST, () => {
  console.log(`[✓] All-in-One Cloud Server online on http://${HOST}:${PORT}`);
  console.log(`  Merchant Admin & Settings: http://${HOST}:${PORT}/admin`);
  console.log(`  Customer Checkout Portal:  http://${HOST}:${PORT}/checkout/:paymentId`);
  console.log(`  Core Payment REST API:     http://${HOST}:${PORT}/api/v1/...`);
  console.log(`  Health Check:              http://${HOST}:${PORT}/health`);
  console.log('====================================================');
});

