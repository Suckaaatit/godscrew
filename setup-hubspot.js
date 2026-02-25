// ── Load env first ────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

// ── Env validation ────────────────────────────────────────────────────────────
const { HUBSPOT_ACCESS_TOKEN } = process.env;

if (!HUBSPOT_ACCESS_TOKEN) {
  console.error('[SETUP] [FATAL] missing=HUBSPOT_ACCESS_TOKEN');
  process.exit(1);
}

const HEADERS = {
  Authorization:  `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

// ── Properties to create ──────────────────────────────────────────────────────
// HubSpot ignores unknown properties on contact creation but returns 400 on
// PATCH if the property does not exist. These must exist before webhook runs.
//
// If this script returns 403: Private App is missing crm.schemas.contacts.write scope.
// Fallback: create manually in HubSpot UI (2 minutes):
//   Settings → Properties → Contact Properties → Create property
//   reply_received  | Single-line text
//   reply_timestamp | Single-line text
//   email_sent      | Single-line text
//   opened_at       | Single-line text
//   clicked_at      | Single-line text
//   lead_intent     | Single-line text

const PROPERTIES = [
  { name: 'reply_received',  label: 'Reply Received'  },
  { name: 'reply_timestamp', label: 'Reply Timestamp' },
  { name: 'email_sent',      label: 'Email Sent'      },
  { name: 'opened_at',       label: 'Opened At'       },
  { name: 'clicked_at',      label: 'Clicked At'      },
  { name: 'lead_intent',     label: 'Lead Intent'     },
];

// ── Create one property ───────────────────────────────────────────────────────
async function createProperty(prop) {
  const response = await fetch(
    'https://api.hubapi.com/crm/v3/properties/contacts',
    {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify({
        name:        prop.name,
        label:       prop.label,
        type:        'string',
        fieldType:   'text',
        groupName:   'contactinformation',
        description: 'Created by anakin-gtm-automation',
      }),
    }
  );

  if (response.status === 409) {
    console.log(`[SETUP] [EXISTS]  property=${prop.name}`);
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    console.error(`[SETUP] [ERROR]   property=${prop.name} status=${response.status} message=${body.message || 'unknown'}`);

    if (response.status === 403) {
      console.error(`[SETUP] [ERROR]   403 = Private App missing crm.schemas.contacts.write scope`);
      console.error(`[SETUP] [ERROR]   Fallback: create "${prop.name}" manually in HubSpot UI`);
    }
    return;
  }

  console.log(`[SETUP] [CREATED] property=${prop.name}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[SETUP] Creating HubSpot custom contact properties...\n');

  for (const prop of PROPERTIES) {
    await createProperty(prop);
  }

  console.log('\n[SETUP] Done.');
  console.log('[SETUP] Verify: HubSpot → Settings → Properties → Contact Properties');
  console.log('[SETUP] If any failed: create them manually (takes 2 minutes).');
}

main();
