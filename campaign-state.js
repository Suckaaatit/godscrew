import fs from 'node:fs';

export const CAMPAIGN_STATE_FILE = 'campaign-state.json';
export const DELIVERY_FILE = 'delivery.json';

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function defaultContact(email) {
  return {
    email: normalizeEmail(email),
    status: 'unknown',
    sent: false,
    opened: false,
    clicked: false,
    replied: false,
    delivered: false,
    failed: false,
    resend_id: null,
    local_message_id: null,
    idempotency_key: null,
    campaign_id: null,
    timestamp: null,
    opened_at: null,
    clicked_at: null,
    reply_timestamp: null,
    lead_intent: null,
    reply_excerpt: null,
    last_error: null,
    updated_at: nowIso(),
  };
}

function defaultState(campaignId) {
  return {
    version: 1,
    campaign_id: campaignId,
    updated_at: nowIso(),
    summary: {
      sent: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      delivered: 0,
      failed: 0,
    },
    contacts: {},
    events: [],
    last_run: null,
  };
}

export function loadCampaignState(campaignId) {
  if (!fs.existsSync(CAMPAIGN_STATE_FILE)) {
    return defaultState(campaignId);
  }

  try {
    const raw = fs.readFileSync(CAMPAIGN_STATE_FILE, 'utf-8').trim();
    if (!raw) return defaultState(campaignId);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState(campaignId);
    if (!parsed.campaign_id) parsed.campaign_id = campaignId;
    if (!parsed.contacts || typeof parsed.contacts !== 'object') parsed.contacts = {};
    if (!Array.isArray(parsed.events)) parsed.events = [];
    if (!parsed.summary || typeof parsed.summary !== 'object') {
      parsed.summary = defaultState(campaignId).summary;
    }
    return parsed;
  } catch {
    return defaultState(campaignId);
  }
}

export function ensureContact(state, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  if (!state.contacts[normalized]) {
    state.contacts[normalized] = defaultContact(normalized);
  }
  return state.contacts[normalized];
}

export function appendCampaignEvent(state, event) {
  const item = {
    timestamp: event?.timestamp || nowIso(),
    type: String(event?.type || 'event'),
    email: normalizeEmail(event?.email || ''),
    message: String(event?.message || ''),
    detail: event?.detail || {},
  };
  state.events.push(item);
  while (state.events.length > 500) state.events.shift();
}

export function recomputeSummary(state) {
  const contacts = Object.values(state.contacts || {});
  state.summary = {
    sent: contacts.filter((c) => c.sent).length,
    opened: contacts.filter((c) => c.opened).length,
    clicked: contacts.filter((c) => c.clicked).length,
    replied: contacts.filter((c) => c.replied).length,
    delivered: contacts.filter((c) => c.delivered).length,
    failed: contacts.filter((c) => c.failed).length,
  };
}

export function recordSendResult(state, payload) {
  const email = normalizeEmail(payload?.email);
  const contact = ensureContact(state, email);
  if (!contact) return;

  const timestamp = payload?.timestamp || nowIso();
  const status = String(payload?.status || 'unknown');
  contact.status = status;
  contact.timestamp = timestamp;
  contact.updated_at = nowIso();
  contact.resend_id = payload?.resend_id ?? contact.resend_id;
  contact.local_message_id = payload?.local_message_id ?? contact.local_message_id;
  contact.idempotency_key = payload?.idempotency_key ?? contact.idempotency_key;
  contact.campaign_id = payload?.campaign_id ?? state.campaign_id;

  if (status === 'sent') {
    contact.sent = true;
    contact.failed = false;
    contact.last_error = null;
  }

  if (status === 'failed') {
    contact.failed = true;
    contact.last_error = payload?.error || 'send_failed';
  }

  if (status === 'dry_run') {
    contact.last_error = null;
  }

  const message = status === 'sent'
    ? `Email sent -> ${email}`
    : status === 'dry_run'
      ? `Dry run prepared -> ${email}`
      : `Send failed -> ${email}`;

  appendCampaignEvent(state, {
    type: `send.${status}`,
    email,
    message,
    timestamp,
    detail: {
      resend_id: contact.resend_id,
      local_message_id: contact.local_message_id,
      idempotency_key: contact.idempotency_key,
      error: payload?.error || null,
    },
  });

  recomputeSummary(state);
}

export function recordEngagement(state, payload) {
  const email = normalizeEmail(payload?.email);
  const contact = ensureContact(state, email);
  if (!contact) return;

  const type = String(payload?.type || '');
  const timestamp = payload?.timestamp || nowIso();

  if (type === 'email.opened') {
    contact.opened = true;
    contact.opened_at = timestamp;
    appendCampaignEvent(state, {
      type,
      email,
      timestamp,
      message: `Email opened -> ${email}`,
    });
  } else if (type === 'email.clicked') {
    contact.clicked = true;
    contact.clicked_at = timestamp;
    appendCampaignEvent(state, {
      type,
      email,
      timestamp,
      message: `Email clicked -> ${email}`,
    });
  } else if (type === 'email.delivered') {
    contact.delivered = true;
    appendCampaignEvent(state, {
      type,
      email,
      timestamp,
      message: `Email delivered -> ${email}`,
    });
  } else if (type === 'inbound.email') {
    contact.replied = true;
    contact.reply_timestamp = timestamp;
    contact.lead_intent = payload?.lead_intent || contact.lead_intent;
    contact.reply_excerpt = payload?.reply_excerpt || contact.reply_excerpt;
    appendCampaignEvent(state, {
      type,
      email,
      timestamp,
      message: `Reply received -> ${email}`,
      detail: {
        lead_intent: contact.lead_intent || 'unknown',
      },
    });
  }

  contact.updated_at = nowIso();
  recomputeSummary(state);
}

export function recordHubSpotPatchEvent(state, payload) {
  appendCampaignEvent(state, {
    type: payload?.ok ? 'hubspot.patch.ok' : 'hubspot.patch.failed',
    email: payload?.email || '',
    timestamp: payload?.timestamp || nowIso(),
    message: payload?.ok
      ? `HubSpot updated -> ${payload?.email}`
      : `HubSpot update failed -> ${payload?.email}`,
    detail: payload?.detail || {},
  });
}

export function setLastRun(state, payload) {
  state.last_run = {
    campaign_id: payload?.campaign_id || state.campaign_id,
    mode: payload?.mode || 'unknown',
    timestamp_start: payload?.timestamp_start || nowIso(),
    timestamp_end: payload?.timestamp_end || nowIso(),
    duration_sec: payload?.duration_sec || 0,
    processed: payload?.processed || 0,
    success: payload?.success || 0,
    failed: payload?.failed || 0,
    dry_run: payload?.dry_run || 0,
    test_send: Boolean(payload?.test_send),
  };
}

function deliveryProjection(state) {
  const output = {};
  const contacts = state.contacts || {};
  for (const [email, contact] of Object.entries(contacts)) {
    output[email] = {
      status: contact.status,
      resend_id: contact.resend_id,
      local_message_id: contact.local_message_id,
      idempotency_key: contact.idempotency_key,
      campaign_id: contact.campaign_id || state.campaign_id,
      timestamp: contact.timestamp,
      opened_at: contact.opened_at,
      clicked_at: contact.clicked_at,
      reply_timestamp: contact.reply_timestamp,
      lead_intent: contact.lead_intent,
      reply_excerpt: contact.reply_excerpt,
      error: contact.last_error,
    };
  }
  return output;
}

export function saveCampaignState(state) {
  state.updated_at = nowIso();
  recomputeSummary(state);
  fs.writeFileSync(CAMPAIGN_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(DELIVERY_FILE, `${JSON.stringify(deliveryProjection(state), null, 2)}\n`, 'utf-8');
}
