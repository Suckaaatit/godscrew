import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { contacts } from './contacts.js';
import {
  appendCampaignEvent,
  loadCampaignState,
  recordSendResult,
  saveCampaignState,
  setLastRun,
} from './campaign-state.js';

const LOCK_FILE = '.sent.lock';
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || 'anakin-assignment-2';
const args = process.argv.slice(2);

const {
  RESEND_API_KEY,
  SENDER_EMAIL,
  SENDER_NAME,
  REPLY_TO_EMAIL,
} = process.env;

const DRY_RUN = isDryRunEnabled(args);
const TEST_SEND = args.includes('--test-send');
const NO_REPLY_TO = args.includes('--no-reply-to');
const TEST_EMAIL = extractArgValue(args, '--test-email') || process.env.TEST_EMAIL || REPLY_TO_EMAIL || '';
const TEST_RUN_ID = TEST_SEND ? randomUUID().slice(0, 8) : '';
const modeLabel = TEST_SEND ? 'test_send' : DRY_RUN ? 'dry_run' : 'live_send';
const lockEnabled = !DRY_RUN && !TEST_SEND;

const requiredEnv = ['SENDER_EMAIL', 'SENDER_NAME'];
if (!TEST_SEND) requiredEnv.push('REPLY_TO_EMAIL');
if (!DRY_RUN) requiredEnv.unshift('RESEND_API_KEY');
if (TEST_SEND && !TEST_EMAIL) requiredEnv.push('TEST_EMAIL_or_REPLY_TO_EMAIL');

const missing = requiredEnv.filter((key) => {
  if (key === 'TEST_EMAIL_or_REPLY_TO_EMAIL') return !TEST_EMAIL;
  return !process.env[key];
});

if (missing.length > 0) {
  log('FATAL', 'missing_env', { keys: missing.join(',') });
  process.exit(1);
}

if (lockEnabled && fs.existsSync(LOCK_FILE)) {
  log('BLOCKED', 'lock_exists', { lock_file: LOCK_FILE });
  log('BLOCKED', 'delete_lock_only_for_intentional_resend', {});
  process.exit(0);
}

const templatePath = new URL('./templates/email.html', import.meta.url);
let template = '';

try {
  template = fs.readFileSync(fileURLToPath(templatePath), 'utf-8');
} catch (err) {
  log('FATAL', 'template_read_failed', { error: err.message });
  process.exit(1);
}

function extractArgValue(allArgs, prefix) {
  const match = allArgs.find((arg) => arg.startsWith(`${prefix}=`));
  if (!match) return '';
  return match.slice(prefix.length + 1).trim();
}

function isDryRunEnabled(allArgs) {
  const cliFlag = allArgs.includes('--dry-run');
  const envFlag = String(process.env.DRY_RUN || '').toLowerCase();
  return cliFlag || envFlag === '1' || envFlag === 'true' || envFlag === 'yes';
}

function sanitize(value) {
  if (value === undefined || value === null) return 'null';
  return String(value).replace(/\s+/g, '_');
}

function log(level, event, fields) {
  const ts = new Date().toISOString();
  const pairs = Object.entries(fields || {})
    .map(([k, v]) => `${k}=${sanitize(v)}`)
    .join(' ');
  const suffix = pairs ? ` ${pairs}` : '';
  console.log(`${ts} [SEND] [${level}] ${event}${suffix}`);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function toHtml(str) {
  return escapeHtml(str).replace(/\n/g, '<br>');
}

function resolveReplyTo(contact) {
  if (NO_REPLY_TO) return null;
  if (contact.type === 'real') return REPLY_TO_EMAIL;
  return null;
}

function buildHtml(contact) {
  return template
    .replace(/{{FIRST_NAME}}/g, toHtml(contact.firstName))
    .replace(/{{CUSTOM_INTRO}}/g, toHtml(contact.customIntro))
    .replace(/{{ANAKIN_LINE}}/g, toHtml(contact.anakinLine))
    .replace(/{{CUSTOM_BODY}}/g, toHtml(contact.customBody))
    .replace(/{{SENDER_NAME}}/g, toHtml(SENDER_NAME));
}

function localMessageId(contact) {
  const source = `${CAMPAIGN_ID}|${contact.email}|${contact.subject}|${TEST_RUN_ID}`;
  return createHash('sha256').update(source).digest('hex').slice(0, 24);
}

function buildResendPayload(contact, replyTo, html) {
  const payload = {
    from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
    to: [contact.email],
    subject: contact.subject,
    html,
    tags: [
      { name: 'campaign', value: CAMPAIGN_ID },
      { name: 'contact_type', value: contact.type || 'unknown' },
    ],
  };

  if (replyTo) payload.reply_to = replyTo;
  return payload;
}

async function sendWithResend(payload, idempotencyKey) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: body?.message || `resend_http_${response.status}`,
      status: response.status,
      id: null,
    };
  }

  return {
    ok: true,
    error: null,
    status: response.status,
    id: body?.id || null,
  };
}

function buildTestContact() {
  return {
    type: 'real',
    email: TEST_EMAIL,
    firstName: 'Akash',
    subject: `[TEST ${TEST_RUN_ID || 'run'}] Anakin Assignment Workflow Check`,
    customIntro: `This is a controlled test send from the assignment command center.
It validates rendering, sender identity, and delivery path before live dispatch.`,
    anakinLine: `Anakin builds AI automation infrastructure for GTM and operations teams,
connecting CRM workflows with intelligent agents in one orchestration layer.`,
    customBody: `If this reaches your inbox, the test path is healthy and ready for
live campaign execution to the three assignment contacts.`,
  };
}

function contactsForRun() {
  if (TEST_SEND) return [buildTestContact()];
  return contacts;
}

function senderDomain(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 0) return '';
  return value.slice(at + 1);
}

function isSandboxSender(email) {
  return senderDomain(email) === 'resend.dev';
}

function domainStatusValue(item) {
  const status = String(
    item?.status ||
      item?.verification_status ||
      item?.state ||
      item?.record_status ||
      ''
  )
    .trim()
    .toLowerCase();
  return status;
}

async function checkSenderDomainReadiness() {
  const domain = senderDomain(SENDER_EMAIL);
  if (!domain) {
    return { ok: false, reason: 'sender_email_invalid' };
  }

  if (isSandboxSender(SENDER_EMAIL)) {
    return {
      ok: false,
      reason: 'sandbox_sender',
      detail:
        'onboarding@resend.dev only supports testing sends to your own account email.',
    };
  }

  try {
    const response = await fetch('https://api.resend.com/domains?limit=100', {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: true,
        reason: 'domain_check_skipped',
        detail: body?.message || `domain_check_http_${response.status}`,
      };
    }

    const domains = Array.isArray(body?.data) ? body.data : [];
    const match = domains.find((item) => String(item?.name || '').toLowerCase() === domain);

    if (!match) {
      return {
        ok: false,
        reason: 'sender_domain_missing',
        detail: `domain_not_found:${domain}`,
      };
    }

    const status = domainStatusValue(match);
    if (status && status !== 'verified' && status !== 'active') {
      return {
        ok: false,
        reason: 'sender_domain_unverified',
        detail: `domain_status:${status}`,
      };
    }

    return { ok: true, reason: 'sender_domain_verified', detail: `domain:${domain}` };
  } catch (err) {
    return {
      ok: true,
      reason: 'domain_check_skipped',
      detail: err.message,
    };
  }
}

async function preflightGuard() {
  if (DRY_RUN || TEST_SEND) return { ok: true };

  const check = await checkSenderDomainReadiness();
  if (!check.ok) {
    log('FATAL', 'send_blocked_preflight', {
      reason: check.reason,
      sender_email: SENDER_EMAIL,
      detail: check.detail || '',
    });
    console.log('');
    console.log('ACTION REQUIRED:');
    console.log('1. Use a Resend API key that can send outside sandbox.');
    console.log('2. Verify a domain in Resend (or use Anakin shared verified domain).');
    console.log('3. Set SENDER_EMAIL to an address on that verified domain.');
    console.log('4. Re-run: npm run send');
    return { ok: false };
  }

  if (check.reason === 'domain_check_skipped') {
    log('WARN', 'domain_preflight_skipped', { detail: check.detail || '' });
  } else {
    log('INFO', 'domain_preflight_ok', { detail: check.detail || '' });
  }

  return { ok: true };
}

async function processContact(contact, campaignState) {
  const startedAt = new Date().toISOString();
  const replyTo = resolveReplyTo(contact);
  const html = buildHtml(contact);
  const messageId = localMessageId(contact);
  const idempotencyKey = `${CAMPAIGN_ID}:${messageId}`;

  if (DRY_RUN) {
    log('DRY_RUN', 'would_send', {
      email: contact.email,
      local_id: messageId,
      campaign_id: CAMPAIGN_ID,
      idempotency_key: idempotencyKey,
    });

    recordSendResult(campaignState, {
      email: contact.email,
      status: 'dry_run',
      resend_id: null,
      local_message_id: messageId,
      idempotency_key: idempotencyKey,
      campaign_id: CAMPAIGN_ID,
      timestamp: startedAt,
    });
    saveCampaignState(campaignState);
    return { ok: true, dryRun: true };
  }

  const payload = buildResendPayload(contact, replyTo, html);
  const result = await sendWithResend(payload, idempotencyKey);

  if (!result.ok) {
    log('ERROR', 'send_failed', {
      email: contact.email,
      local_id: messageId,
      campaign_id: CAMPAIGN_ID,
      status_code: result.status,
      error: result.error,
    });

    recordSendResult(campaignState, {
      email: contact.email,
      status: 'failed',
      resend_id: null,
      local_message_id: messageId,
      idempotency_key: idempotencyKey,
      campaign_id: CAMPAIGN_ID,
      timestamp: startedAt,
      error: result.error,
    });
    saveCampaignState(campaignState);
    return { ok: false, dryRun: false };
  }

  log('SUCCESS', 'sent', {
    email: contact.email,
    local_id: messageId,
    resend_id: result.id || 'unknown',
    campaign_id: CAMPAIGN_ID,
    idempotency_key: idempotencyKey,
  });

  recordSendResult(campaignState, {
    email: contact.email,
    status: 'sent',
    resend_id: result.id,
    local_message_id: messageId,
    idempotency_key: idempotencyKey,
    campaign_id: CAMPAIGN_ID,
    timestamp: startedAt,
  });
  saveCampaignState(campaignState);
  return { ok: true, dryRun: false };
}

function printSummary(stats, durationMs) {
  const durationSec = (durationMs / 1000).toFixed(2);
  console.log('');
  console.log('========== EXECUTION SUMMARY ==========');
  console.log(`timestamp_utc : ${new Date().toISOString()}`);
  console.log(`campaign_id   : ${CAMPAIGN_ID}`);
  console.log(`mode          : ${modeLabel}`);
  console.log(`processed     : ${stats.processed}`);
  console.log(`success       : ${stats.success}`);
  console.log(`failed        : ${stats.failed}`);
  console.log(`dry_run       : ${stats.dryRun}`);
  console.log(`test_send     : ${TEST_SEND}`);
  console.log(`duration_sec  : ${durationSec}`);
  console.log('=======================================');
}

async function main() {
  const start = Date.now();
  const startIso = new Date().toISOString();
  const campaignState = loadCampaignState(CAMPAIGN_ID);
  const runContacts = contactsForRun();
  const stats = { processed: 0, success: 0, failed: 0, dryRun: 0 };

  const guard = await preflightGuard();
  if (!guard.ok) {
    setLastRun(campaignState, {
      campaign_id: CAMPAIGN_ID,
      mode: modeLabel,
      timestamp_start: startIso,
      timestamp_end: new Date().toISOString(),
      duration_sec: Number(((Date.now() - start) / 1000).toFixed(2)),
      processed: 0,
      success: 0,
      failed: runContacts.length,
      dry_run: 0,
      test_send: TEST_SEND,
    });
    appendCampaignEvent(campaignState, {
      type: 'dispatch.blocked',
      timestamp: new Date().toISOString(),
      message: 'Campaign send blocked by preflight validation',
      detail: { mode: modeLabel, contacts: runContacts.length },
    });
    saveCampaignState(campaignState);
    process.exit(1);
  }

  appendCampaignEvent(campaignState, {
    type: 'dispatch.start',
    timestamp: startIso,
    message: TEST_SEND ? 'Test send started' : 'Campaign send started',
    detail: { mode: modeLabel, contacts: runContacts.length },
  });
  saveCampaignState(campaignState);

  log('INFO', 'dispatch_start', {
    contacts: runContacts.length,
    campaign_id: CAMPAIGN_ID,
    mode: modeLabel,
    no_reply_to: NO_REPLY_TO,
  });

  for (const contact of runContacts) {
    stats.processed += 1;
    const result = await processContact(contact, campaignState);
    if (result.dryRun) stats.dryRun += 1;
    if (result.ok) stats.success += 1;
    if (!result.ok) stats.failed += 1;
  }

  if (lockEnabled && stats.success > 0) {
    fs.writeFileSync(LOCK_FILE, `${new Date().toISOString()}\n`, 'utf-8');
    log('INFO', 'lock_written', { lock_file: LOCK_FILE, sent_count: stats.success });
  } else if (DRY_RUN || TEST_SEND) {
    log('INFO', 'lock_skipped_safe_mode', { lock_file: LOCK_FILE });
  } else {
    log('WARN', 'lock_skipped_zero_success', { lock_file: LOCK_FILE });
  }

  const durationMs = Date.now() - start;
  const endIso = new Date().toISOString();

  setLastRun(campaignState, {
    campaign_id: CAMPAIGN_ID,
    mode: modeLabel,
    timestamp_start: startIso,
    timestamp_end: endIso,
    duration_sec: Number((durationMs / 1000).toFixed(2)),
    processed: stats.processed,
    success: stats.success,
    failed: stats.failed,
    dry_run: stats.dryRun,
    test_send: TEST_SEND,
  });

  appendCampaignEvent(campaignState, {
    type: 'dispatch.complete',
    timestamp: endIso,
    message: TEST_SEND ? 'Test send completed' : 'Campaign send completed',
    detail: { processed: stats.processed, success: stats.success, failed: stats.failed },
  });
  saveCampaignState(campaignState);

  printSummary(stats, durationMs);

  if (!DRY_RUN && stats.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  log('FATAL', 'unhandled_error', { error: err.message });
  process.exit(1);
});
