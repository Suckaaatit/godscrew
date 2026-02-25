// @ts-nocheck
"use strict";
const ENV_FIELDS = [
    { key: "RESEND_API_KEY", label: "Resend API Key", note: "Required for live sends", secret: true, logo: "resend" },
    { key: "SENDER_EMAIL", label: "Sender Email", note: "Verified sender in Resend", logo: "mail" },
    { key: "SENDER_NAME", label: "Sender Name", note: "Displayed in From header", logo: "mail" },
    { key: "REPLY_TO_EMAIL", label: "Reply-To Email", note: "Inbox for guaranteed replies", logo: "mail" },
    { key: "HUBSPOT_ACCESS_TOKEN", label: "HubSpot Token", note: "Private app access token", secret: true, logo: "hubspot" },
    { key: "NGROK_STATIC_DOMAIN", label: "Ngrok Static Domain", note: "Webhook public endpoint domain", logo: "ngrok" },
    { key: "WEBHOOK_PORT", label: "Webhook Port", note: "Port used by webhook server", logo: "webhook" },
    { key: "CAMPAIGN_ID", label: "Campaign ID", note: "Tag used for logs/state", logo: "campaign" },
    { key: "DRY_RUN", label: "Default Dry-Run", note: "true = simulate sends only", logo: "shield" },
    { key: "TEST_EMAIL", label: "Test Email", note: "Used by Send Test Email button", logo: "mail" },
    { key: "RESEND_WEBHOOK_SIGNING_SECRET", label: "Svix Signing Secret", note: "Resend webhook secret", secret: true, logo: "webhook" },
    { key: "ENFORCE_WEBHOOK_SIGNATURE", label: "Enforce Signature", note: "true = reject unsigned webhook requests", logo: "shield" },
    { key: "SLACK_WEBHOOK_URL", label: "Slack Webhook URL", note: "Optional Slack alert channel", secret: true, logo: "slack" },
    { key: "MISTRAL_API_KEY", label: "Mistral API Key", note: "Optional intent classifier", secret: true, logo: "mistral" },
    { key: "MISTRAL_MODEL", label: "Mistral Model", note: "Intent model override", logo: "mistral" },
    { key: "MISTRAL_TIMEOUT_MS", label: "Model Timeout (ms)", note: "Intent request timeout", logo: "mistral" },
];
const state = {
    envValues: {},
    envMessage: "",
    envMessageKind: "neutral",
    campaign: {
        campaign_id: "anakin-assignment-2",
        summary: { sent: 0, opened: 0, clicked: 0, replied: 0, failed: 0, delivered: 0 },
        contacts: [],
        events: [],
        replies: [],
        last_run: null,
        updated_at: null,
    },
    system: {
        resendApi: { status: "Loading", detail: "..." },
        hubspotApi: { status: "Loading", detail: "..." },
        webhookServer: { status: "Loading", detail: "..." },
        ngrokTunnel: { status: "Loading", detail: "..." },
        signatureVerify: { status: "Loading", detail: "..." },
    },
    taskSession: null,
    webhook: { running: false, pid: null, startedAt: null, logTail: "" },
    busy: false,
    busyLabel: "",
    lastRefreshedAt: "",
};
let realtimeHandle = null;
let taskPollHandle = null;
function create(tag, className) {
    const el = document.createElement(tag);
    if (className)
        el.className = className;
    return el;
}
const ICON_SVG = {
    campaign: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M7 16V7m5 9V5m5 11v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="17" cy="10" r="1.5" fill="currentColor"/></svg>`,
    resend: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12c2.2-4 5-6 8-6 3.2 0 5.8 1.8 8 6-2.2 4-4.8 6-8 6-3 0-5.8-2-8-6Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>`,
    hubspot: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="14" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.2" cy="6.8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m10.6 11.9 4.8-3.7M11.2 14h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    slack: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="9.5" width="5" height="11" rx="2.5" fill="#36C5F0"/><rect x="6.5" y="3" width="5" height="11" rx="2.5" fill="#2EB67D"/><rect x="9.5" y="16" width="11" height="5" rx="2.5" fill="#E01E5A"/><rect x="16" y="6.5" width="5" height="11" rx="2.5" fill="#ECB22E"/></svg>`,
    mistral: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V6h3.1l2.6 4.7L12.3 6h3.2v13h-2.8v-7.6l-2.5 4.4h-.9l-2.5-4.4V19H4Zm12.4 0V6H20v13h-3.6Z" fill="currentColor"/></svg>`,
    ngrok: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg>`,
    webhook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 9.4A4.5 4.5 0 1 1 12 16.5h-2.2M15.8 14.6A4.5 4.5 0 1 1 12 7.5h2.2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="7" cy="16.5" r="2" fill="currentColor"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 5.5 6v5.5c0 4.2 2.6 7.5 6.5 9 3.9-1.5 6.5-4.8 6.5-9V6L12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m9.5 12 1.8 1.9 3.6-3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    mail: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m5.5 8 6.5 4.9L18.5 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    test: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l1 2.5h3v2H5v-2h3L9 4Zm-2 6h10l-.8 9.2a2 2 0 0 1-2 1.8H9.8a2 2 0 0 1-2-1.8L7 10Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
    dry: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16c2-4.5 4.8-6.8 8.2-8.3 1.5-.7 3.2-.2 4.1 1.2.8 1.3.6 3-.4 4.1-2.5 2.7-5.7 4.5-9.8 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="7" cy="17" r="2.2" fill="currentColor"/></svg>`,
    setup: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.6 4.5-.5 2.1a5.5 5.5 0 0 0-1.6.9l-2-1-1.6 2.8 1.7 1.3a5.6 5.6 0 0 0 0 1.8l-1.7 1.3 1.6 2.8 2-1c.5.4 1 .7 1.6.9l.5 2.1h3.2l.5-2.1c.6-.2 1.1-.5 1.6-.9l2 1 1.6-2.8-1.7-1.3a5.6 5.6 0 0 0 0-1.8l1.7-1.3-1.6-2.8-2 1a5.5 5.5 0 0 0-1.6-.9l-.5-2.1H9.6Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></svg>`,
    contacts: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="9" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.8 18.2c.8-2.4 2.4-3.7 4.2-3.7s3.4 1.3 4.2 3.7M17 10.5a2.5 2.5 0 1 0 0-5M15.5 18c.5-1.8 1.6-2.8 3-2.8 1.1 0 2.1.6 2.8 1.8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
    play: `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="8,6 19,12 8,18" fill="currentColor"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.2" fill="currentColor"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2-4.9M19 5v4h-4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    feed: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="2" fill="currentColor"/><path d="M4 11a9 9 0 0 1 9 9M4 6a14 14 0 0 1 14 14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
    reply: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8 4 12l5 4v-3h4.2a5.3 5.3 0 0 1 5.3 5.3V20a7 7 0 0 0-7-7H9V8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    summary: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4.5" width="14" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7.5 10 2.5 2-2.5 2M11.5 14h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    cube: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 3.7v10.6L12 21 5 17.3V6.7L12 3Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5 6.7 7 3.6 7-3.6M12 10.3V21" stroke="currentColor" stroke-width="1.5"/></svg>`,
};
function icon(name, className = "glyph") {
    const span = create("span", className);
    span.innerHTML = ICON_SVG[name] || ICON_SVG.campaign;
    return span;
}
function logoBadge(provider, label, active) {
    const badge = create("div", `provider-badge provider-${provider} ${active ? "provider-active" : "provider-inactive"}`);
    badge.append(icon(provider, "provider-icon"), create("span", "provider-label"));
    badge.lastChild.textContent = label;
    return badge;
}
function headerLabel(title, iconName) {
    const wrap = create("div", "head-label");
    const text = create("span", "head-text");
    text.textContent = title;
    wrap.append(icon(iconName, "glyph head-glyph"), text);
    return wrap;
}
function buildHeader(title, iconName, rightNode) {
    const head = create("div", "section-head");
    head.append(headerLabel(title, iconName));
    if (rightNode) {
        const aside = create("div", "head-right");
        aside.append(rightNode);
        head.append(aside);
    }
    return head;
}
function actionContent(iconName, text) {
    const wrap = create("span", "action-content");
    const txt = create("span");
    txt.textContent = text;
    wrap.append(icon(iconName, "glyph action-glyph"), txt);
    return wrap;
}
function eventIcon(type, message) {
    const normalized = `${String(type || "")} ${String(message || "")}`.toLowerCase();
    if (normalized.includes("reply"))
        return "reply";
    if (normalized.includes("open"))
        return "feed";
    if (normalized.includes("click"))
        return "campaign";
    if (normalized.includes("webhook"))
        return "webhook";
    if (normalized.includes("dry"))
        return "dry";
    if (normalized.includes("fail") || normalized.includes("error"))
        return "shield";
    return "mail";
}
function renderHero(root) {
    const hero = create("section", "hero section");
    const copy = create("div", "hero-copy");
    const eyebrow = create("p", "hero-eyebrow");
    eyebrow.textContent = "GTM Automation Ops";
    const title = create("h1", "hero-title");
    title.textContent = "Assignment 2 Command Center";
    const subtitle = create("p", "hero-subtitle");
    subtitle.textContent = "Live send controls, telemetry, reply intelligence, and deterministic campaign state.";
    const stamp = create("p", "hero-stamp");
    stamp.textContent = new Date().toLocaleString();
    const providers = create("div", "hero-providers");
    providers.append(logoBadge("resend", "Resend", Boolean((state.envValues.RESEND_API_KEY || "").trim())), logoBadge("hubspot", "HubSpot", Boolean((state.envValues.HUBSPOT_ACCESS_TOKEN || "").trim())), logoBadge("slack", "Slack", Boolean((state.envValues.SLACK_WEBHOOK_URL || "").trim())), logoBadge("mistral", "Mistral", Boolean((state.envValues.MISTRAL_API_KEY || "").trim())), logoBadge("ngrok", "Ngrok", Boolean((state.envValues.NGROK_STATIC_DOMAIN || "").trim())));
    copy.append(eyebrow, title, subtitle, stamp, providers);
    const visual = create("div", "hero-visual");
    const orbit = create("div", "hero-orbit");
    orbit.append(icon("resend", "glyph orbit-logo orbit-a"), icon("hubspot", "glyph orbit-logo orbit-b"), icon("slack", "glyph orbit-logo orbit-c"), icon("mistral", "glyph orbit-logo orbit-d"));
    const cube = create("div", "cube");
    for (let i = 0; i < 6; i += 1) {
        const face = create("div", `cube-face cube-face-${i + 1}`);
        if (i === 0) {
            const core = create("div", "cube-core");
            core.append(icon("cube", "glyph cube-core-icon"));
            face.append(core);
        }
        cube.append(face);
    }
    visual.append(orbit, cube);
    hero.append(copy, visual);
    root.append(hero);
}
async function apiGet(url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) {
        throw new Error(body?.error || `request_failed_${res.status}`);
    }
    return body;
}
async function apiPost(url, payload) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body?.error || `request_failed_${res.status}`);
    }
    return body;
}
function statusTone(status) {
    const text = String(status || "").toLowerCase();
    if (text.includes("connected") || text.includes("running") || text.includes("active") || text.includes("enabled")) {
        return "good";
    }
    if (text.includes("failed") || text.includes("error") || text.includes("misconfigured") || text.includes("stopped")) {
        return "bad";
    }
    return "warn";
}
function shortTime(iso) {
    if (!iso)
        return "--:--";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return "--:--";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function setMessage(text, kind) {
    state.envMessage = text;
    state.envMessageKind = kind;
}
async function loadEnv() {
    const data = await apiGet("/api/env");
    state.envValues = data.values || {};
}
async function saveEnv() {
    state.busy = true;
    state.busyLabel = "Saving .env";
    render();
    try {
        await apiPost("/api/env", { values: state.envValues });
        setMessage("Saved .env successfully.", "ok");
    }
    catch (err) {
        setMessage(`Save failed: ${err.message}`, "error");
    }
    finally {
        state.busy = false;
        state.busyLabel = "";
        render();
    }
}
async function refreshCampaign() {
    const data = await apiGet("/api/campaign/state");
    state.campaign = {
        campaign_id: data.campaign_id,
        summary: data.summary,
        contacts: data.contacts || [],
        events: data.events || [],
        replies: data.replies || [],
        last_run: data.last_run || null,
        updated_at: data.updated_at || null,
    };
}
async function refreshSystemStatus() {
    const data = await apiGet("/api/system/status");
    state.system = data.report;
}
async function refreshWebhook() {
    const data = await apiGet("/api/webhook/status");
    state.webhook = data;
}
async function refreshTaskSession() {
    const data = await apiGet("/api/tasks/session");
    state.taskSession = data.session;
}
async function fullRefresh() {
    await Promise.all([refreshCampaign(), refreshSystemStatus(), refreshWebhook(), refreshTaskSession()]);
    state.lastRefreshedAt = new Date().toLocaleTimeString();
}
function startRealtimePolling() {
    if (realtimeHandle !== null)
        return;
    realtimeHandle = window.setInterval(async () => {
        try {
            await Promise.all([refreshCampaign(), refreshSystemStatus(), refreshWebhook()]);
            state.lastRefreshedAt = new Date().toLocaleTimeString();
            render();
        }
        catch {
            // silent periodic retry
        }
    }, 4000);
}
function stopTaskPolling() {
    if (taskPollHandle === null)
        return;
    window.clearInterval(taskPollHandle);
    taskPollHandle = null;
}
function startTaskPolling() {
    stopTaskPolling();
    taskPollHandle = window.setInterval(async () => {
        try {
            await refreshTaskSession();
            if (!state.taskSession || state.taskSession.status !== "running") {
                stopTaskPolling();
                await refreshCampaign();
            }
            render();
        }
        catch {
            stopTaskPolling();
        }
    }, 900);
}
async function startTask(taskId, label) {
    if (state.busy)
        return;
    if (taskId === "send_campaign") {
        const proceed = window.confirm("This sends real emails. Continue?");
        if (!proceed)
            return;
    }
    state.busy = true;
    state.busyLabel = label;
    render();
    try {
        await apiPost("/api/tasks/start", { taskId });
        await refreshTaskSession();
        startTaskPolling();
    }
    catch (err) {
        const message = String(err.message);
        if (message === "task_in_progress") {
            setMessage("Another task is currently running.", "error");
        }
        else {
            setMessage(`Task failed to start: ${message}`, "error");
        }
    }
    finally {
        state.busy = false;
        state.busyLabel = "";
        render();
    }
}
async function startWebhook() {
    if (state.busy)
        return;
    state.busy = true;
    state.busyLabel = "Starting webhook";
    render();
    try {
        await apiPost("/api/webhook/start", {});
        await Promise.all([refreshWebhook(), refreshSystemStatus()]);
    }
    catch (err) {
        setMessage(`Webhook start failed: ${err.message}`, "error");
    }
    finally {
        state.busy = false;
        state.busyLabel = "";
        render();
    }
}
async function stopWebhook() {
    if (state.busy)
        return;
    state.busy = true;
    state.busyLabel = "Stopping webhook";
    render();
    try {
        await apiPost("/api/webhook/stop", {});
        await Promise.all([refreshWebhook(), refreshSystemStatus()]);
    }
    catch (err) {
        setMessage(`Webhook stop failed: ${err.message}`, "error");
    }
    finally {
        state.busy = false;
        state.busyLabel = "";
        render();
    }
}
function metricCard(label, value, helper, iconName) {
    const card = create("article", "metric-card");
    const top = create("div", "metric-top");
    top.append(icon(iconName, "glyph metric-glyph"));
    const k = create("p", "metric-key");
    k.textContent = label;
    top.append(k);
    const v = create("p", "metric-value");
    v.textContent = value;
    const h = create("p", "metric-help");
    h.textContent = helper;
    card.append(top, v, h);
    return card;
}
function renderTopRow(root) {
    const row = create("section", "top-row");
    const statsPanel = create("section", "section panel");
    const statsHead = buildHeader("Campaign Stats", "campaign");
    const statsBody = create("div", "metrics-grid");
    const s = state.campaign.summary;
    statsBody.append(metricCard("Campaign", state.campaign.campaign_id || "anakin-assignment-2", "Current campaign ID", "campaign"), metricCard("Sent", String(s.sent || 0), "Unique contacts sent", "mail"), metricCard("Opened", String(s.opened || 0), "Open events tracked", "feed"), metricCard("Replied", String(s.replied || 0), "Inbound replies tracked", "reply"), metricCard("Failed", String(s.failed || 0), "Send failures", "shield"), metricCard("Clicked", String(s.clicked || 0), "Click events tracked", "campaign"));
    statsPanel.append(statsHead, statsBody);
    const systemPanel = create("section", "section panel");
    const systemHead = buildHeader("System Status", "shield");
    const systemBody = create("div", "status-list");
    const items = [
        { label: "Resend API", value: state.system.resendApi, icon: "resend" },
        { label: "HubSpot API", value: state.system.hubspotApi, icon: "hubspot" },
        { label: "Webhook Server", value: state.system.webhookServer, icon: "webhook" },
        { label: "Ngrok Tunnel", value: state.system.ngrokTunnel, icon: "ngrok" },
        { label: "Signature Verify", value: state.system.signatureVerify, icon: "shield" },
    ];
    for (const item of items) {
        const line = create("div", "status-line");
        const label = create("span", "status-label status-with-icon");
        label.append(icon(item.icon, "glyph status-glyph"));
        const labelText = create("span");
        label.textContent = item.label;
        labelText.textContent = item.label;
        label.replaceChildren(icon(item.icon, "glyph status-glyph"), labelText);
        const chip = create("span", `status-chip chip-${statusTone(item.value.status)}`);
        chip.textContent = item.value.status;
        const detail = create("span", "status-detail");
        detail.textContent = item.value.detail;
        line.append(label, chip, detail);
        systemBody.append(line);
    }
    systemPanel.append(systemHead, systemBody);
    row.append(statsPanel, systemPanel);
    root.append(row);
}
function renderActions(root) {
    const panel = create("section", "section");
    const head = buildHeader("Campaign Controls", "play");
    const bar = create("div", "toolbar");
    const defs = [
        { label: "Send Campaign", taskId: "send_campaign", danger: true, icon: "campaign" },
        { label: "Send Test Email to Myself", taskId: "send_test", icon: "test" },
        { label: "Send Dry Run", taskId: "send_dry_run", icon: "dry" },
        { label: "Run Setup", taskId: "setup", icon: "setup" },
        { label: "Create Contacts", taskId: "create_contacts", icon: "contacts" },
        { label: "Start Webhook", onClick: () => startWebhook(), icon: "play" },
        { label: "Stop Webhook", onClick: () => stopWebhook(), icon: "stop" },
        { label: "Refresh", onClick: () => fullRefresh().then(render), icon: "refresh" },
    ];
    for (const def of defs) {
        const btn = create("button", `action ${def.danger ? "action-danger" : ""} action-with-icon`);
        btn.type = "button";
        btn.append(actionContent(def.icon || "campaign", def.label));
        btn.disabled = state.busy;
        btn.addEventListener("click", async () => {
            if (def.taskId)
                await startTask(def.taskId, def.label);
            else if (def.onClick)
                await def.onClick();
            render();
        });
        bar.append(btn);
    }
    const footer = create("div", "status-strip");
    const active = create("span");
    const session = state.taskSession;
    if (session && session.status === "running") {
        active.textContent = `Running: ${session.label}`;
    }
    else if (session) {
        active.textContent = `Last task: ${session.label} (${session.status}, exit ${session.exitCode ?? "n/a"})`;
    }
    else {
        active.textContent = "No task started yet.";
    }
    const refreshed = create("span");
    refreshed.textContent = state.lastRefreshedAt ? `Refreshed: ${state.lastRefreshedAt}` : "Refreshed: --";
    footer.append(active, refreshed);
    panel.append(head, bar, footer);
    root.append(panel);
}
function renderMainGrid(root) {
    const wrap = create("section", "main-grid");
    const feedPanel = create("section", "section");
    const feedHead = buildHeader("Live Event Feed", "feed");
    const feed = create("div", "event-feed");
    if (!state.campaign.events.length) {
        const empty = create("p", "empty");
        empty.textContent = "No events yet. Run Send Campaign, then watch opens/replies flow in.";
        feed.append(empty);
    }
    else {
        for (const event of state.campaign.events) {
            const row = create("div", "event-row");
            const time = create("span", "event-time");
            time.textContent = shortTime(event.timestamp);
            const eventGlyph = icon(eventIcon(event.type, event.message), "glyph event-glyph");
            const text = create("span", "event-text");
            text.textContent = event.message || event.type;
            row.append(time, eventGlyph, text);
            feed.append(row);
        }
    }
    feedPanel.append(feedHead, feed);
    const side = create("div", "side-stack");
    const contactsPanel = create("section", "section");
    const contactsHead = buildHeader("Contacts", "contacts");
    const tableWrap = create("div", "table-wrap");
    const table = create("table", "contacts-table");
    const thead = create("thead");
    const headRow = create("tr");
    ["Email", "Sent", "Opened", "Replied", "Status"].forEach((label) => {
        const th = create("th");
        th.textContent = label;
        headRow.append(th);
    });
    thead.append(headRow);
    const tbody = create("tbody");
    for (const c of state.campaign.contacts) {
        const tr = create("tr");
        const email = create("td");
        email.textContent = c.email;
        const sent = create("td");
        sent.textContent = c.sent ? "YES" : "NO";
        const opened = create("td");
        opened.textContent = c.opened ? "YES" : "NO";
        const replied = create("td");
        replied.textContent = c.replied ? "YES" : "NO";
        const status = create("td");
        status.textContent = c.status || "-";
        tr.append(email, sent, opened, replied, status);
        tbody.append(tr);
    }
    table.append(thead, tbody);
    tableWrap.append(table);
    contactsPanel.append(contactsHead, tableWrap);
    const replyPanel = create("section", "section");
    const replyHead = buildHeader("Reply Viewer", "reply");
    const replyBody = create("div", "reply-list");
    if (!state.campaign.replies.length) {
        const empty = create("p", "empty");
        empty.textContent = "No replies recorded yet.";
        replyBody.append(empty);
    }
    else {
        for (const reply of state.campaign.replies.slice(0, 4)) {
            const card = create("article", "reply-card");
            const who = create("p", "reply-who");
            who.textContent = `Reply from ${reply.email}`;
            const when = create("p", "reply-when");
            when.textContent = reply.reply_timestamp || "";
            const excerpt = create("p", "reply-text");
            excerpt.textContent = reply.reply_excerpt || "(no body)";
            const intent = create("p", "reply-intent");
            intent.textContent = `Intent: ${reply.lead_intent || "unknown"}`;
            card.append(who, when, excerpt, intent);
            replyBody.append(card);
        }
    }
    replyPanel.append(replyHead, replyBody);
    const summaryPanel = create("section", "section");
    const summaryHead = buildHeader("Execution Summary", "summary");
    const summaryBody = create("div", "summary-body");
    const run = state.campaign.last_run;
    if (!run) {
        const empty = create("p", "empty");
        empty.textContent = "No completed run yet.";
        summaryBody.append(empty);
    }
    else {
        const lines = [
            `Campaign: ${run.campaign_id}`,
            `Mode: ${run.mode}`,
            `Duration: ${run.duration_sec}s`,
            `Processed: ${run.processed}`,
            `Success: ${run.success}`,
            `Failures: ${run.failed}`,
            `Dry Run: ${run.dry_run}`,
        ];
        for (const line of lines) {
            const p = create("p", "summary-line");
            p.textContent = line;
            summaryBody.append(p);
        }
    }
    summaryPanel.append(summaryHead, summaryBody);
    side.append(contactsPanel, replyPanel, summaryPanel);
    wrap.append(feedPanel, side);
    root.append(wrap);
}
function renderLogs(root) {
    const row = create("section", "logs-row");
    const taskPanel = create("section", "section");
    const taskHead = buildHeader("Command Output", "terminal");
    const pre = create("pre", "log");
    pre.textContent = state.taskSession?.output || "(start a task to stream logs)";
    taskPanel.append(taskHead, pre);
    const webhookPanel = create("section", "section");
    const webhookHead = buildHeader("Webhook Log Tail", "webhook");
    const webhookLog = create("pre", "log");
    webhookLog.textContent = state.webhook.logTail || "(webhook not started)";
    webhookPanel.append(webhookHead, webhookLog);
    row.append(taskPanel, webhookPanel);
    root.append(row);
}
function renderEnv(root) {
    const panel = create("section", "section env-panel");
    const logos = create("div", "provider-logos");
    const resendActive = Boolean((state.envValues.RESEND_API_KEY || "").trim());
    const slackActive = Boolean((state.envValues.SLACK_WEBHOOK_URL || "").trim());
    const hubspotActive = Boolean((state.envValues.HUBSPOT_ACCESS_TOKEN || "").trim());
    const mistralActive = Boolean((state.envValues.MISTRAL_API_KEY || "").trim());
    const ngrokActive = Boolean((state.envValues.NGROK_STATIC_DOMAIN || "").trim());
    logos.append(logoBadge("resend", "Resend", resendActive), logoBadge("slack", "Slack", slackActive), logoBadge("hubspot", "HubSpot", hubspotActive), logoBadge("mistral", "Mistral", mistralActive), logoBadge("ngrok", "Ngrok", ngrokActive));
    const head = buildHeader(".env Editor", "setup", logos);
    const grid = create("div", "env-grid");
    for (const field of ENV_FIELDS) {
        const card = create("article", "env");
        const label = create("label", "env-label");
        const labelText = create("span");
        labelText.textContent = field.label;
        label.append(icon(field.logo || "campaign", "glyph env-field-glyph"), labelText);
        const input = create("input", "env-input");
        input.value = state.envValues[field.key] || "";
        input.placeholder = field.key;
        input.type = field.secret ? "password" : "text";
        input.addEventListener("input", () => {
            state.envValues[field.key] = input.value;
        });
        const note = create("small");
        note.textContent = `${field.key} - ${field.note}`;
        card.append(label, input, note);
        grid.append(card);
    }
    const actions = create("div", "toolbar");
    const saveBtn = create("button", "action");
    saveBtn.textContent = "Save .env";
    saveBtn.disabled = state.busy;
    saveBtn.addEventListener("click", async () => {
        await saveEnv();
    });
    const reloadBtn = create("button", "action action-ghost");
    reloadBtn.textContent = "Reload .env";
    reloadBtn.disabled = state.busy;
    reloadBtn.addEventListener("click", async () => {
        try {
            await loadEnv();
            setMessage("Reloaded .env values.", "neutral");
            render();
        }
        catch (err) {
            setMessage(`Reload failed: ${err.message}`, "error");
            render();
        }
    });
    const msg = create("span", `msg msg-${state.envMessageKind}`);
    msg.textContent = state.envMessage || "Edit values, then save.";
    actions.append(saveBtn, reloadBtn, msg);
    panel.append(head, grid, actions);
    root.append(panel);
}
function render() {
    const root = document.getElementById("app");
    if (!root)
        return;
    root.replaceChildren();
    renderHero(root);
    renderTopRow(root);
    renderActions(root);
    renderMainGrid(root);
    renderLogs(root);
    renderEnv(root);
}
async function init() {
    try {
        await Promise.all([loadEnv(), fullRefresh()]);
        state.lastRefreshedAt = new Date().toLocaleTimeString();
        startRealtimePolling();
        if (state.taskSession && state.taskSession.status === "running") {
            startTaskPolling();
        }
    }
    catch (err) {
        state.envMessage = `Load error: ${err.message}`;
        state.envMessageKind = "error";
    }
    finally {
        render();
    }
}
init();
