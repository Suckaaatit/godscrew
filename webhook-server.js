import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { Webhook } from 'svix';
import {
  appendCampaignEvent,
  loadCampaignState,
  recordEngagement,
  recordHubSpotPatchEvent,
  saveCampaignState,
} from './campaign-state.js';

const {
  HUBSPOT_ACCESS_TOKEN,
  WEBHOOK_PORT,
  NGROK_STATIC_DOMAIN,
  RESEND_WEBHOOK_SIGNING_SECRET,
  ENFORCE_WEBHOOK_SIGNATURE,
  SLACK_WEBHOOK_URL,
  MISTRAL_API_KEY,
  MISTRAL_MODEL,
  MISTRAL_TIMEOUT_MS,
  CAMPAIGN_ID,
} = process.env;

if (!HUBSPOT_ACCESS_TOKEN) {
  log('FATAL', 'missing_env', { key: 'HUBSPOT_ACCESS_TOKEN' });
  process.exit(1);
}

const PORT = parseInt(WEBHOOK_PORT || '3000', 10);
const NGROK = NGROK_STATIC_DOMAIN || 'https://YOUR-STATIC.ngrok-free.app';
const MODEL = MISTRAL_MODEL || 'mistral-small-latest';
const MODEL_TIMEOUT_MS = parseInt(MISTRAL_TIMEOUT_MS || '8000', 10);
const REQUIRE_SIGNATURE = parseBool(ENFORCE_WEBHOOK_SIGNATURE || 'false');
const ACTIVE_CAMPAIGN_ID = CAMPAIGN_ID || 'anakin-assignment-2';

const verifier = RESEND_WEBHOOK_SIGNING_SECRET
  ? new Webhook(RESEND_WEBHOOK_SIGNING_SECRET)
  : null;

if (REQUIRE_SIGNATURE && !verifier) {
  log('FATAL', 'signature_required_but_secret_missing', {
    env: 'RESEND_WEBHOOK_SIGNING_SECRET',
  });
  process.exit(1);
}

const app = express();

function parseBool(value) {
  const val = String(value || '').toLowerCase();
  return val === '1' || val === 'true' || val === 'yes';
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
  console.log(`${ts} [WEBHOOK] [${level}] ${event}${suffix}`);
}

function withCampaignState(mutator) {
  const state = loadCampaignState(ACTIVE_CAMPAIGN_ID);
  mutator(state);
  saveCampaignState(state);
}

function headerValue(headers, key) {
  const direct = headers[key];
  if (Array.isArray(direct)) return direct[0];
  return direct || '';
}

function parseEmail(raw) {
  if (!raw) return '';
  const source = Array.isArray(raw) ? raw[0] : raw;
  if (typeof source === 'object' && source?.email) return String(source.email).toLowerCase().trim();
  const text = String(source);
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).toLowerCase().trim();
}

function eventTimestamp(event) {
  return event?.data?.created_at || event?.created_at || new Date().toISOString();
}

function extractSenderEmail(event) {
  return parseEmail(event?.data?.from || event?.from);
}

function extractRecipientEmail(event) {
  const candidates = [
    event?.data?.to,
    event?.data?.recipient,
    event?.data?.email,
    event?.to,
  ];

  for (const candidate of candidates) {
    const parsed = parseEmail(candidate);
    if (parsed) return parsed;
  }
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractReplyText(event) {
  const text = event?.data?.text || event?.text;
  if (text) return String(text).trim();
  const html = event?.data?.html || event?.html;
  return stripHtml(html);
}

function replyExcerpt(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  return source.slice(0, 220);
}

function normalizeHubSpotProperties(properties) {
  const output = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (value === null) output[key] = '';
    else if (typeof value === 'boolean') output[key] = value ? 'true' : 'false';
    else output[key] = String(value);
  }
  return output;
}

async function patchContactProperties(email, properties) {
  const encodedEmail = encodeURIComponent(email);
  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${encodedEmail}?idProperty=email`;
  const payload = {
    properties: normalizeHubSpotProperties(properties),
  };

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    log('SUCCESS', 'hubspot_patch_ok', {
      email,
      updated: Object.keys(payload.properties).join(','),
    });
    return { ok: true, status: response.status, detail: null };
  }

  const body = await response.json().catch(() => ({}));
  if (response.status === 404) {
    log('WARN', 'hubspot_contact_not_found', { email });
  } else if (response.status === 400) {
    log('ERROR', 'hubspot_property_missing', {
      email,
      message: body.message || 'property_missing_or_invalid',
    });
  } else {
    log('ERROR', 'hubspot_patch_failed', {
      email,
      status_code: response.status,
      message: body.message || 'unknown_error',
    });
  }
  return {
    ok: false,
    status: response.status,
    detail: body?.message || 'hubspot_patch_failed',
  };
}

async function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) return;

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    log('ERROR', 'slack_notify_failed', { status_code: response.status });
    return;
  }

  log('INFO', 'slack_notified', {});
}

function parseIntentLabel(raw) {
  const text = String(raw || '').toLowerCase();
  if (text.includes('positive')) return 'positive';
  if (text.includes('negative')) return 'negative';
  if (text.includes('question')) return 'question';
  if (text.includes('neutral')) return 'neutral';
  return 'unknown';
}

function extractModelText(payload) {
  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }

  const mistralChoice = payload?.choices?.[0]?.message?.content;
  if (typeof mistralChoice === 'string') {
    return mistralChoice;
  }

  if (Array.isArray(mistralChoice)) {
    const textChunk = mistralChoice.find((item) => typeof item?.text === 'string');
    if (textChunk?.text) return textChunk.text;
  }

  const output = payload?.output;
  if (Array.isArray(output)) {
    const first = output[0];
    const content = first?.content;
    if (Array.isArray(content) && content.length > 0) {
      const textItem = content.find((item) => typeof item?.text === 'string');
      if (textItem?.text) return textItem.text;
    }
  }

  return '';
}

async function classifyIntent(replyText) {
  if (!MISTRAL_API_KEY || !replyText) return 'unknown';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 12,
        messages: [
          {
            role: 'system',
            content:
              'Classify lead reply intent. Return exactly one label: positive, negative, question, or neutral.',
          },
          {
            role: 'user',
            content: replyText.slice(0, 3500),
          },
        ],
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      log('WARN', 'intent_model_http_error', {
        status_code: response.status,
        message: payload?.error?.message || 'unknown',
      });
      return 'unknown';
    }

    const modelText = extractModelText(payload);
    return parseIntentLabel(modelText);
  } catch (err) {
    log('WARN', 'intent_model_error', { error: err.message });
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

function parseAndVerifyEvent(rawBody, headers) {
  if (!rawBody) throw new Error('empty_request_body');

  if (verifier) {
    const svixHeaders = {
      'svix-id': headerValue(headers, 'svix-id'),
      'svix-timestamp': headerValue(headers, 'svix-timestamp'),
      'svix-signature': headerValue(headers, 'svix-signature'),
    };

    if (!svixHeaders['svix-id'] || !svixHeaders['svix-timestamp'] || !svixHeaders['svix-signature']) {
      throw new Error('missing_svix_headers');
    }

    return verifier.verify(rawBody, svixHeaders);
  }

  if (REQUIRE_SIGNATURE) throw new Error('signature_enforced_without_verifier');
  return JSON.parse(rawBody);
}

async function handleInboundReply(event) {
  const email = extractSenderEmail(event);
  if (!email) {
    log('WARN', 'reply_parse_failed_missing_sender', {});
    return;
  }

  const replyText = extractReplyText(event);
  const intent = await classifyIntent(replyText);
  const timestamp = eventTimestamp(event);

  const patch = await patchContactProperties(email, {
    reply_received: 'true',
    reply_timestamp: timestamp,
    lead_intent: intent,
  });

  withCampaignState((state) => {
    recordEngagement(state, {
      type: 'inbound.email',
      email,
      timestamp,
      lead_intent: intent,
      reply_excerpt: replyExcerpt(replyText),
    });
    recordHubSpotPatchEvent(state, {
      ok: patch.ok,
      email,
      timestamp,
      detail: { reason: patch.detail || null },
    });
  });

  if (!patch.ok) return;

  await notifySlack(
    `Reply received from ${email}\nLead intent: ${intent}\nHubSpot record updated`
  );
}

async function handleOpened(event) {
  const email = extractRecipientEmail(event);
  if (!email) {
    log('WARN', 'opened_parse_failed_missing_recipient', {});
    return;
  }

  const timestamp = eventTimestamp(event);
  const patch = await patchContactProperties(email, {
    opened_at: timestamp,
  });

  withCampaignState((state) => {
    recordEngagement(state, {
      type: 'email.opened',
      email,
      timestamp,
    });
    recordHubSpotPatchEvent(state, {
      ok: patch.ok,
      email,
      timestamp,
      detail: { reason: patch.detail || null, event: 'email.opened' },
    });
  });
}

async function handleClicked(event) {
  const email = extractRecipientEmail(event);
  if (!email) {
    log('WARN', 'clicked_parse_failed_missing_recipient', {});
    return;
  }

  const timestamp = eventTimestamp(event);
  const patch = await patchContactProperties(email, {
    clicked_at: timestamp,
  });

  withCampaignState((state) => {
    recordEngagement(state, {
      type: 'email.clicked',
      email,
      timestamp,
    });
    recordHubSpotPatchEvent(state, {
      ok: patch.ok,
      email,
      timestamp,
      detail: { reason: patch.detail || null, event: 'email.clicked' },
    });
  });
}

async function handleDelivered(event) {
  const email = extractRecipientEmail(event);
  if (!email) {
    log('WARN', 'delivered_parse_failed_missing_recipient', {});
    return;
  }

  const timestamp = eventTimestamp(event);
  const patch = await patchContactProperties(email, {
    email_sent: 'true',
  });

  withCampaignState((state) => {
    recordEngagement(state, {
      type: 'email.delivered',
      email,
      timestamp,
    });
    recordHubSpotPatchEvent(state, {
      ok: patch.ok,
      email,
      timestamp,
      detail: { reason: patch.detail || null, event: 'email.delivered' },
    });
  });
}

async function processEvent(event) {
  const eventType = event?.type || 'unknown';
  log('INFO', 'event_received', { type: eventType });

  withCampaignState((state) => {
    appendCampaignEvent(state, {
      type: 'webhook.received',
      timestamp: eventTimestamp(event),
      message: `Webhook received -> ${eventType}`,
      detail: { event_type: eventType },
    });
  });

  if (eventType === 'inbound.email') {
    await handleInboundReply(event);
    return;
  }

  if (eventType === 'email.opened') {
    await handleOpened(event);
    return;
  }

  if (eventType === 'email.clicked') {
    await handleClicked(event);
    return;
  }

  if (eventType === 'email.delivered') {
    await handleDelivered(event);
    return;
  }

  log('INFO', 'event_ignored', { type: eventType });
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/webhook/resend', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  let event;
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body || '');

  try {
    event = parseAndVerifyEvent(rawBody, req.headers);
  } catch (err) {
    log('ERROR', 'webhook_rejected', { error: err.message });
    res.status(400).json({ received: false, error: 'invalid_webhook' });
    return;
  }

  res.status(200).json({ received: true });

  setImmediate(async () => {
    try {
      await processEvent(event);
    } catch (err) {
      log('ERROR', 'event_processing_failed', { error: err.message });
    }
  });
});

app.listen(PORT, () => {
  console.log('===========================================================');
  console.log(' Anakin GTM - Webhook Server');
  console.log('===========================================================');
  console.log(` Local:    http://localhost:${PORT}`);
  console.log(` Health:   http://localhost:${PORT}/health`);
  console.log(` Endpoint: http://localhost:${PORT}/webhook/resend`);
  console.log('');
  console.log(` Signature verification: ${verifier ? 'enabled' : 'disabled'}`);
  console.log(` Signature enforcement:  ${REQUIRE_SIGNATURE ? 'strict' : 'permissive'}`);
  console.log(` Slack notification:     ${SLACK_WEBHOOK_URL ? 'enabled' : 'disabled'}`);
  console.log(` Intent model:           ${MISTRAL_API_KEY ? `Mistral (${MODEL})` : 'disabled'}`);
  console.log(` Campaign state file:    campaign-state.json (${ACTIVE_CAMPAIGN_ID})`);
  console.log('');
  console.log(' NEXT STEPS:');
  console.log(` 1. ngrok: ngrok http --domain=${NGROK.replace('https://', '')} ${PORT}`);
  console.log(` 2. Test:  curl ${NGROK}/health`);
  console.log(' 3. Resend -> Webhooks -> Add Endpoint:');
  console.log(`    URL:    ${NGROK}/webhook/resend`);
  console.log('    Events: inbound.email, email.opened, email.clicked, email.delivered');
  console.log('===========================================================');
});
