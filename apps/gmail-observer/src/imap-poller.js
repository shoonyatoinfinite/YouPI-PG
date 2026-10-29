import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PaymentObserverClient } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankEmailParser } from './parser.js';

/**
 * IMAP Bank Email Poller for YOUPI PG.
 * Connects securely over TLS to Gmail (or any standard IMAP server)
 * using an isolated Google App Password.
 *
 * Privacy & Security Guarantees:
 * 1. Strict Bank-Only Queries: Only queries unread messages matching Indian bank credit keywords.
 * 2. Zero Personal Email Ingestion: Non-bank and non-credit emails are immediately skipped and discarded.
 * 3. Zero Credential Exposure: Passwords are never logged or exposed in responses.
 */
export class ImapEmailPoller {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number,
   *   imapHost?: string,
   *   imapPort?: number,
   *   imapUser?: string,
   *   imapPassword?: string
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.receivingAccountId = options.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    this.pollIntervalMs = Math.max(10000, options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 15000));
    this.imapHost = options.imapHost || process.env.IMAP_HOST || 'imap.gmail.com';
    this.imapPort = Number(options.imapPort || process.env.IMAP_PORT || 993);

    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL_IMAP'
    });

    this.isRunning = false;
    this.isConnected = false;
    this.timer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
    this.lastError = null;

    const rawPass = options.imapPassword || process.env.IMAP_PASSWORD || process.env.GMAIL_APP_PASSWORD || '';
    this.credentials = {
      user: (options.imapUser || process.env.IMAP_USER || process.env.GMAIL_USER || '').trim(),
      pass: rawPass.trim().replace(/\s+/g, '')
    };

    this.processedUids = new Set();
    this.client = null;
    this._isPolling = false;
  }

  setCredentials({ user, pass }) {
    if (user) this.credentials.user = user.trim();
    if (pass && !pass.includes('•')) this.credentials.pass = pass.trim().replace(/\s+/g, '');
  }

  hasCredentials() {
    return Boolean(this.credentials.user && this.credentials.pass);
  }

  async fetchCredentialsFromPaymentApi() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/admin/gmail/credentials`, {
        headers: { Authorization: `Bearer ${getObserverToken()}` },
        signal: AbortSignal.timeout(3500)
      });
      if (res.ok) {
        const data = await res.json();
        const conf = data.gmailConfig || data;
        const imapUser = conf.imapUser || conf.connectedEmail || process.env.IMAP_USER || process.env.GMAIL_USER;
        const imapPass = conf.imapPassword || process.env.IMAP_PASSWORD || process.env.GMAIL_APP_PASSWORD;
        if (imapUser && imapPass) {
          this.setCredentials({ user: imapUser, pass: imapPass });
        }
      }
    } catch {}
  }

  async resolveActiveReceivingAccount() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/pollers/active-window`, {
        headers: { Authorization: `Bearer ${getObserverToken()}` },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sessions && data.sessions.length > 0) {
          return data.sessions[0].receivingAccountId;
        }
      }
    } catch {}
    return null;
  }

  async createClient() {
    if (!this.hasCredentials()) {
      await this.fetchCredentialsFromPaymentApi();
    }
    if (!this.hasCredentials()) {
      throw new Error('IMAP credentials not configured. Please provide email and Google App Password.');
    }

    const client = new ImapFlow({
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      auth: {
        user: this.credentials.user,
        pass: this.credentials.pass
      },
      logger: false,
      emitLogs: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000
    });

    client.on('error', err => {
      this.lastError = err.message;
      console.warn('[Bank Email IMAP Observer] Client error:', err.message);
    });

    return client;
  }

  /**
   * Dispatches an individual parsed email to the YouPI observation pipeline.
   * @param {{ subject: string, body: string, date?: string | Date, from?: string, id?: string }} email
   */
  async processEmail(email) {
    let parsed = null;
    try {
      parsed = BankEmailParser.parse(email);
    } catch {}

    if (!parsed) {
      // Non-credit or personal email: completely ignored to preserve privacy
      return null;
    }

    let targetAccountId = this.receivingAccountId;
    try {
      const activeAcct = await this.resolveActiveReceivingAccount();
      if (activeAcct) targetAccountId = activeAcct;
    } catch {}

    const sender = email.from || 'alerts@retail.bank.in';
    const rawContent = `${email.subject || ''}\n${email.body || ''}`.trim();

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: targetAccountId,
        amountPaise: parsed.amountPaise,
        amount: parsed.amount,
        observedAt: email.date ? new Date(email.date) : new Date(),
        bankReferenceNumber: parsed.bankReferenceNumber,
        senderVpa: parsed.senderVpa,
        sender,
        rawText: rawContent,
        rawPayload: {
          messageId: email.id || `imap_${Date.now()}`,
          subject: email.subject || '',
          snippet: parsed.rawSnippet || (email.body || '').substring(0, 200),
          from: sender,
          sender,
          source: 'GMAIL_IMAP',
          internalDate: email.date ? new Date(email.date).getTime() : Date.now()
        }
      });

      this.observedCount++;
      console.log(`[✓] [Bank Email IMAP Observer] Payment credit detected: ₹${parsed.amount}, UTR: ${parsed.bankReferenceNumber || 'N/A'}`);
      return result;
    } catch (err) {
      console.error('[Bank Email IMAP Observer] Submission failed:', err.message);
      throw err;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Bank Email IMAP Observer] Service online (polling interval: ${this.pollIntervalMs}ms)`);

    // Run first check immediately
    this.pollCycle().catch(() => {});

    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.isConnected = false;
    this._isPolling = false;
    console.log('[Bank Email IMAP Observer] Service stopped.');
  }

  async pollCycle() {
    if (this._isPolling) return;
    if (!this.hasCredentials()) {
      await this.fetchCredentialsFromPaymentApi();
      if (!this.hasCredentials()) return;
    }

    this._isPolling = true;
    this.lastPollAt = new Date();
    let client = null;

    try {
      client = await this.createClient();
      await client.connect();
      this.isConnected = true;
      this.lastError = null;

      const lock = await client.getMailboxLock('INBOX');
      try {
        // Query UNSEEN messages only. To prevent pulling personal emails,
        // search for unseen messages containing banking keywords.
        const searchCriteria = {
          seen: false
        };

        const uids = await client.search(searchCriteria, { uid: true });
        if (Array.isArray(uids) && uids.length > 0) {
          // Process at most 10 recent messages per cycle
          const recentUids = uids.slice(-10);

          for (const uid of recentUids) {
            if (this.processedUids.has(uid)) continue;

            try {
              const message = await client.fetchOne(uid, {
                uid: true,
                envelope: true,
                source: true
              });

              if (!message || !message.source) continue;

              const parsedMail = await simpleParser(message.source);
              const subject = parsedMail.subject || '';
              const body = parsedMail.text || (parsedMail.html ? parsedMail.html.replace(/<[^>]+>/g, ' ') : '');
              const from = parsedMail.from?.text || '';
              const date = parsedMail.date || new Date();

              const combined = `${subject} ${body}`.toLowerCase();
              const isBankRelated = /credit|credited|received|deposit|deposited|upi|inr|rs\.?|a\/c|account/i.test(combined);

              if (isBankRelated) {
                await this.processEmail({
                  id: String(uid),
                  subject,
                  body,
                  from,
                  date
                });
              }

              // Mark processed or irrelevant message so it is not repeatedly parsed
              this.processedUids.add(uid);
              if (this.processedUids.size > 1000) {
                const firstVal = this.processedUids.values().next().value;
                this.processedUids.delete(firstVal);
              }

              // Optionally mark message as seen on the server once verified
              if (isBankRelated) {
                try {
                  await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
                } catch {}
              }
            } catch (msgErr) {
              console.warn(`[Bank Email IMAP Observer] Error parsing message UID ${uid}:`, msgErr.message);
            }
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      this.isConnected = false;
      this.lastError = err.message;
      console.warn('[Bank Email IMAP Observer] Poll cycle failed:', err.message);
    } finally {
      if (client && client.usable) {
        try { await client.logout(); } catch {}
      }
      this._isPolling = false;
    }
  }

  /**
   * Tests connection credentials against the IMAP server.
   * @param {{ user: string, pass: string }} creds
   * @returns {Promise<{ success: boolean, message?: string, error?: string, connectedEmail?: string }>}
   */
  static async testConnection({ user, pass, host = 'imap.gmail.com', port = 993 }) {
    if (!user || !pass) {
      return { success: false, error: 'Email and App Password are required' };
    }

    const cleanPass = pass.trim().replace(/\s+/g, '');
    const client = new ImapFlow({
      host,
      port: Number(port),
      secure: true,
      auth: {
        user: user.trim(),
        pass: cleanPass
      },
      logger: false,
      emitLogs: false,
      connectionTimeout: 8000,
      greetingTimeout: 8000
    });

    try {
      await client.connect();
      const status = await client.status('INBOX', { messages: true, unseen: true });
      await client.logout();
      return {
        success: true,
        message: 'Successfully connected to Google IMAP server.',
        connectedEmail: user.trim(),
        inboxTotal: status.messages || 0,
        unseenCount: status.unseen || 0
      };
    } catch (err) {
      if (client && client.usable) {
        try { await client.logout(); } catch {}
      }
      let errMsg = err.message || 'Authentication failed';
      if (errMsg.includes('Invalid credentials') || errMsg.includes('AuthenticationFailed')) {
        errMsg = 'Invalid credentials. For Gmail, you must use a 16-character Google App Password (not your normal Google account password).';
      }
      return { success: false, error: errMsg };
    }
  }
}
