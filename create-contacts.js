// ── Load env first ────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

// ── Env validation ────────────────────────────────────────────────────────────
const { HUBSPOT_ACCESS_TOKEN } = process.env;

if (!HUBSPOT_ACCESS_TOKEN) {
  console.error('[CREATE] [FATAL] missing=HUBSPOT_ACCESS_TOKEN');
  process.exit(1);
}

const HEADERS = {
  Authorization:  `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

// ── Contact definitions ───────────────────────────────────────────────────────
const CONTACTS = [
  {
    email:     'kotharitosh@gmail.com',
    firstname: 'Tosh',
    lastname:  'Kothari',
    company:   'Anakin',
    jobtitle:  'Co-Founder',
  },
  {
    email:     'viral.patel@anakinai.com',
    firstname: 'Viral',
    lastname:  'Patel',
    company:   'Anakin',
    jobtitle:  'GTM Lead',
  },
  {
    email:     'viral.sensehawk@gmail.com',
    firstname: 'Viral',
    lastname:  'Patel',
    company:   'SenseHawk',
    jobtitle:  'Co-Founder',
  },
];

// ── Search for existing contact ───────────────────────────────────────────────
async function findContact(email) {
  const response = await fetch(
    'https://api.hubapi.com/crm/v3/objects/contacts/search',
    {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator:     'EQ',
            value:        email,
          }],
        }],
        properties: ['email', 'firstname'],
        limit: 5,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Search failed: ${response.status} ${body.message || ''}`);
  }

  const data = await response.json();

  if (data.total > 1) {
    console.warn(`[CREATE] [WARN]   email=${email} multiple_found=${data.total} using_first`);
  }

  return data.results?.[0] ?? null;
}

// ── Create contact ────────────────────────────────────────────────────────────
async function createContact(contact) {
  const response = await fetch(
    'https://api.hubapi.com/crm/v3/objects/contacts',
    {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify({
        properties: {
          email:          contact.email,
          firstname:      contact.firstname,
          lastname:       contact.lastname,
          company:        contact.company,
          jobtitle:       contact.jobtitle,
          reply_received: 'false',
          email_sent:     'false',
          opened_at:      '',
          clicked_at:     '',
          lead_intent:    '',
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    console.error(`[CREATE] [ERROR]   email=${contact.email} status=${response.status} message=${body.message || 'unknown'}`);
    return;
  }

  const data = await response.json();
  console.log(`[CREATE] [SUCCESS] email=${contact.email} hubspot_id=${data.id}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[CREATE] Starting HubSpot contact creation...\n');

  for (const contact of CONTACTS) {
    let existing;

    try {
      existing = await findContact(contact.email);
    } catch (err) {
      console.error(`[CREATE] [ERROR]   email=${contact.email} search_error=${err.message}`);
      continue;
    }

    if (existing) {
      console.log(`[CREATE] [EXISTS]  email=${contact.email} hubspot_id=${existing.id}`);
      continue;
    }

    await createContact(contact);
  }

  console.log('\n[CREATE] Done. Verify: HubSpot → Contacts → Contacts');
}

main();
