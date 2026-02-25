// Pure static data. No imports. No process.env.
//
// type: 'real' → send-emails.js sets reply_to to REPLY_TO_EMAIL (personal inbox)
// type: 'test' → send-emails.js omits reply_to entirely so reply routes through
//                Resend inbound MX and webhook fires (Tier 2 pre-flight only)
//
// Multiline strings use physical newlines intentionally.
// send-emails.js converts \n → <br> before HTML injection.

export const contacts = [
  {
    type:        'real',
    email:       'kotharitosh@gmail.com',
    firstName:   'Tosh',
    subject:     'Tosh — a question about AI agent infrastructure',
    customIntro: `Your work at the earliest stages of AI infrastructure —
before most teams understood what they were actually building —
is the context that makes Anakin's approach worth your attention.`,
    anakinLine:  `Anakin is an AI agent platform that lets GTM and operations teams
deploy intelligent automation workflows without managing ML pipelines —
the layer founders like you spent years building the hard way.`,
    customBody:  `Would genuinely value a quick reaction from someone
who has been inside that infrastructure layer.`,
  },
  {
    type:        'real',
    email:       'viral.patel@anakinai.com',
    firstName:   'Viral',
    subject:     'Viral — on the GTM automation layer at Anakin',
    customIntro: `I know you are evaluating this submission directly,
so I will be straight: I built this workflow to demonstrate
the requirement rather than just describe it.`,
    anakinLine:  `Anakin enables GTM and operations teams to run AI agents across
their workflows — the orchestration layer that replaces fragile
point-to-point integrations with one intelligent system.`,
    customBody:  `The architecture mirrors how I would think about Anakin's own stack:
CRM as source of truth, programmatic dispatch, closed-loop reply tracking.
Happy to walk through any part of it.`,
  },
  {
    type:        'real',
    email:       'viral.sensehawk@gmail.com',
    firstName:   'Viral',
    subject:     'Viral — Anakin\'s automation layer and SenseHawk\'s stack',
    customIntro: `Building SenseHawk into an infrastructure intelligence platform —
applying data automation to physical assets at field scale —
is exactly the kind of operational thinking Anakin applies on the GTM side.`,
    anakinLine:  `Anakin is building the AI agent operating system for business teams:
the layer that connects CRM data, outbound workflows, and intelligent
automation into one orchestrated system.`,
    customBody:  `Same philosophy as SenseHawk — automation as infrastructure, not a feature.
Wanted to connect given the overlap.`,
  },
];

// ── Test contact (Tier 2 webhook pre-flight ONLY) ─────────────────────────────
// Uncomment before webhook test. Re-comment before real send.
// type: 'test' → reply_to omitted → reply routes through Resend inbound → webhook fires.
//
// {
//   type:        'test',
//   email:       'your.personal@gmail.com',
//   firstName:   'Test',
//   subject:     'Webhook pre-flight — ignore',
//   customIntro: 'Test only.',
//   anakinLine:  'Test only.',
//   customBody:  'Test only.',
// },
