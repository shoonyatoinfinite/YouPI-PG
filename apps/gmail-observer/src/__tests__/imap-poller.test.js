import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { ImapEmailPoller } from '../imap-poller.js';
import { BankEmailParser } from '../parser.js';
import { TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

describe('IMAP Bank Email Observer Tests', () => {
  let apiInstance;
  let observerInstance;
  let observerBaseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6197, testDb);
    observerInstance = await startGmailObserver(6098, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });
    observerBaseUrl = `http://localhost:${observerInstance.port}`;
  });

  after(async () => {
    await observerInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function post(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {});
      const req = http.request(`${observerBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      }, res => {
        let resData = '';
        res.on('data', chunk => { resData += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, data: resData ? JSON.parse(resData) : {} });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  test('ImapEmailPoller initializes with clean defaults', () => {
    const poller = new ImapEmailPoller({
      imapUser: 'test@gmail.com',
      imapPassword: 'abcd efgh ijkl mnop'
    });

    assert.equal(poller.credentials.user, 'test@gmail.com');
    assert.equal(poller.credentials.pass, 'abcdefghijklmnop'); // whitespace stripped
    assert.equal(poller.hasCredentials(), true);
    assert.equal(poller.isRunning, false);
  });

  test('ImapEmailPoller ignores personal and non-bank emails to protect user privacy', async () => {
    const poller = new ImapEmailPoller({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      imapUser: 'test@gmail.com',
      imapPassword: 'test'
    });

    const personalEmail = {
      subject: 'Hey, are we still meeting today?',
      body: 'See you at the coffee shop at 4 PM.',
      from: 'friend@example.com'
    };

    const res = await poller.processEmail(personalEmail);
    assert.equal(res, null, 'Personal emails must return null and be skipped completely');
    assert.equal(poller.observedCount, 0);
  });

  test('ImapEmailPoller processes genuine bank credit email and submits observation', async () => {
    // 1. Create a payment session in Payment API for Rs 350.00
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'IMAP-ORD-350',
      amountPaise: 35000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    const poller = new ImapEmailPoller({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      imapUser: 'test@gmail.com',
      imapPassword: 'test'
    });

    const bankEmail = {
      subject: 'Account Credited: INR 350.00',
      body: 'Your A/C ending 4321 is credited with INR 350.00 on 29-Oct-2026. Ref no: UTR-SBI-5599 via UPI.',
      from: 'alerts@sbi.co.in',
      date: new Date()
    };

    const res = await poller.processEmail(bankEmail);
    assert.ok(res, 'Bank credit email must be successfully ingested');
    assert.equal(poller.observedCount, 1);
    assert.equal(res.accepted, true);
    assert.equal(res.attribution.paymentSessionId, session.id);
  });

  test('POST /api/imap/test requires authorization', async () => {
    const res = await post('/api/imap/test', { user: 'a@b.com', pass: 'secret' });
    assert.equal(res.status, 401);
  });

  test('POST /api/imap/start starts IMAP poller when authorized', async () => {
    const res = await post('/api/imap/start', {
      user: 'merchant@gmail.com',
      pass: 'testpass12345678'
    }, {
      Authorization: `Bearer ${TEST_OBSERVER_TOKEN}`
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
  });
});
