import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { contacts as staticContacts } from "../contacts.js";

const __filename = fileURLToPath(import.meta.url);
const uiDir = path.dirname(__filename);
const rootDir = path.resolve(uiDir, "..");
const app = express();
const port = Number.parseInt(process.env.UI_PORT || "5173", 10);

const CAMPAIGN_STATE_FILE = path.join(rootDir, "campaign-state.json");
const DELIVERY_FILE = path.join(rootDir, "delivery.json");

const ENV_KEYS = [
  "RESEND_API_KEY",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "REPLY_TO_EMAIL",
  "HUBSPOT_ACCESS_TOKEN",
  "NGROK_STATIC_DOMAIN",
  "CAMPAIGN_ID",
  "DRY_RUN",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  "ENFORCE_WEBHOOK_SIGNATURE",
  "SLACK_WEBHOOK_URL",
  "MISTRAL_API_KEY",
  "MISTRAL_MODEL",
  "MISTRAL_TIMEOUT_MS",
  "WEBHOOK_PORT",
  "TEST_EMAIL",
];

const TASKS = {
  setup: {
    label: "Run Setup",
    command: "npm run setup",
    extraEnv: {},
  },
  create_contacts: {
    label: "Create Contacts",
    command: "npm run create-contacts",
    extraEnv: {},
  },
  send_campaign: {
    label: "Send Campaign",
    command: "npm run send",
    extraEnv: { DRY_RUN: "false" },
  },
  send_test: {
    label: "Send Test Email",
    command: "npm run send -- --test-send --no-reply-to",
    extraEnv: { DRY_RUN: "false" },
  },
  send_dry_run: {
    label: "Send Dry Run",
    command: "npm run send -- --dry-run",
    extraEnv: { DRY_RUN: "true" },
  },
};

let taskSession = null;
let taskCounter = 0;
let webhookProcess = null;
let webhookStartedAt = null;
const webhookLogs = [];

app.use(express.json({ limit: "1mb" }));
app.use(express.static(uiDir));

function nowIso() {
  return new Date().toISOString();
}

function envPath() {
  return path.join(rootDir, ".env");
}

function keepTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function parseBool(value) {
  const val = String(value || "").toLowerCase();
  return val === "1" || val === "true" || val === "yes";
}

function readEnvText() {
  const file = envPath();
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

function parseEnvValues() {
  const values = {};
  const lines = readEnvText().split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2];
  }
  return values;
}

function updateEnvFile(updates) {
  const file = envPath();
  const existing = readEnvText();
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const touched = new Set();

  const rewritten = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return line;
    const key = match[1];
    if (!(key in updates)) return line;
    touched.add(key);
    return `${key}=${String(updates[key] ?? "")}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (touched.has(key)) continue;
    rewritten.push(`${key}=${String(value ?? "")}`);
  }

  fs.writeFileSync(file, rewritten.join(eol), "utf-8");
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value ?? "");
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function looksPlaceholder(value) {
  const text = String(value || "").toLowerCase().trim();
  if (!text) return true;
  return (
    text.includes("xxxx") ||
    text.includes("your-") ||
    text.includes("your.") ||
    text.includes("example.com") ||
    text === "changeme"
  );
}

function normalizeDomain(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `https://${raw}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function pushWebhookLog(source, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    webhookLogs.push(`${nowIso()} [${source}] ${line}`);
  }

  while (webhookLogs.length > 400) webhookLogs.shift();
}

function webhookStatus() {
  return {
    running: Boolean(webhookProcess && webhookProcess.exitCode === null),
    pid: webhookProcess?.pid || null,
    startedAt: webhookStartedAt,
    logTail: webhookLogs.join("\n"),
  };
}

function serializeTaskSession() {
  if (!taskSession) return null;
  return {
    sessionId: taskSession.sessionId,
    taskId: taskSession.taskId,
    label: taskSession.label,
    command: taskSession.command,
    status: taskSession.status,
    startedAt: taskSession.startedAt,
    finishedAt: taskSession.finishedAt,
    exitCode: taskSession.exitCode,
    durationMs: taskSession.durationMs,
    output: taskSession.output,
    error: taskSession.error,
  };
}

function taskRunning() {
  return Boolean(taskSession && taskSession.status === "running");
}

function startTask(taskId) {
  if (!(taskId in TASKS)) {
    throw new Error("unknown_task");
  }
  if (taskRunning()) {
    throw new Error("task_in_progress");
  }

  const definition = TASKS[taskId];
  const session = {
    sessionId: `task-${Date.now()}-${++taskCounter}`,
    taskId,
    label: definition.label,
    command: definition.command,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    exitCode: null,
    durationMs: null,
    output: "",
    error: null,
    startedAtMs: Date.now(),
  };
  taskSession = session;

  const child = spawn(definition.command, {
    cwd: rootDir,
    shell: true,
    env: {
      ...process.env,
      ...definition.extraEnv,
    },
  });

  const append = (chunk) => {
    session.output = keepTail(`${session.output}${String(chunk)}`, 500000);
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);

  child.on("error", (err) => {
    session.status = "failed";
    session.error = err.message;
    session.finishedAt = nowIso();
    session.durationMs = Date.now() - session.startedAtMs;
    session.exitCode = -1;
  });

  child.on("close", (code) => {
    session.status = code === 0 ? "completed" : "failed";
    session.finishedAt = nowIso();
    session.durationMs = Date.now() - session.startedAtMs;
    session.exitCode = code ?? -1;
  });

  return session;
}

function runUtility(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function startWebhook() {
  if (webhookProcess && webhookProcess.exitCode === null) {
    return false;
  }

  webhookLogs.length = 0;
  webhookStartedAt = nowIso();
  const child = spawn("npm run webhook", {
    cwd: rootDir,
    shell: true,
    env: { ...process.env },
  });

  webhookProcess = child;
  pushWebhookLog("SYSTEM", "webhook_start_requested");

  child.stdout.on("data", (chunk) => pushWebhookLog("STDOUT", chunk));
  child.stderr.on("data", (chunk) => pushWebhookLog("STDERR", chunk));

  child.on("error", (err) => {
    pushWebhookLog("SYSTEM", `webhook_error ${err.message}`);
  });

  child.on("close", (code, signal) => {
    pushWebhookLog("SYSTEM", `webhook_stopped code=${code ?? "null"} signal=${signal ?? "null"}`);
    webhookProcess = null;
    webhookStartedAt = null;
  });

  return true;
}

async function stopWebhook() {
  if (!webhookProcess || webhookProcess.exitCode !== null) return false;
  const pid = webhookProcess.pid;
  if (!pid) return false;

  if (process.platform === "win32") {
    const ok = await runUtility("C:\\Windows\\System32\\taskkill.exe", [
      "/PID",
      String(pid),
      "/T",
      "/F",
    ]);
    pushWebhookLog("SYSTEM", ok ? "webhook_stop_taskkill_ok" : "webhook_stop_taskkill_failed");
    return ok;
  }

  webhookProcess.kill("SIGTERM");
  pushWebhookLog("SYSTEM", "webhook_stop_signal_sent");
  return true;
}

function mergedContacts(campaignState) {
  const map = new Map();
  for (const item of staticContacts) {
    map.set(String(item.email).toLowerCase(), {
      email: String(item.email).toLowerCase(),
      firstName: item.firstName || "",
      source: "assignment",
    });
  }

  for (const [email, status] of Object.entries(campaignState.contacts || {})) {
    const current = map.get(email) || { email, firstName: "", source: "runtime" };
    map.set(email, { ...current, ...status });
  }

  return Array.from(map.values()).sort((a, b) => a.email.localeCompare(b.email));
}

function campaignStateForUi() {
  const state = readJsonFile(CAMPAIGN_STATE_FILE, {
    campaign_id: process.env.CAMPAIGN_ID || "anakin-assignment-2",
    summary: { sent: 0, opened: 0, replied: 0, failed: 0, clicked: 0, delivered: 0 },
    contacts: {},
    events: [],
    last_run: null,
  });

  const contacts = mergedContacts(state);
  const events = Array.isArray(state.events) ? state.events.slice(-80).reverse() : [];
  const replies = contacts
    .filter((c) => c.replied && c.reply_excerpt)
    .sort((a, b) => String(b.reply_timestamp || "").localeCompare(String(a.reply_timestamp || "")));

  return {
    campaign_id: state.campaign_id || process.env.CAMPAIGN_ID || "anakin-assignment-2",
    summary: state.summary || { sent: 0, opened: 0, replied: 0, failed: 0, clicked: 0, delivered: 0 },
    contacts,
    events,
    replies,
    last_run: state.last_run || null,
    updated_at: state.updated_at || null,
  };
}

async function systemStatusReport() {
  const env = parseEnvValues();
  const resendKey = env.RESEND_API_KEY || "";
  const hubspotToken = env.HUBSPOT_ACCESS_TOKEN || "";
  const ngrokDomain = normalizeDomain(env.NGROK_STATIC_DOMAIN || "");
  const enforceSignature = parseBool(env.ENFORCE_WEBHOOK_SIGNATURE || "");
  const secretConfigured = Boolean(env.RESEND_WEBHOOK_SIGNING_SECRET) && !looksPlaceholder(env.RESEND_WEBHOOK_SIGNING_SECRET);

  const resendCheck = (async () => {
    if (looksPlaceholder(resendKey)) {
      return { status: "Not Configured", detail: "Set RESEND_API_KEY" };
    }
    try {
      const response = await fetchWithTimeout("https://api.resend.com/domains?limit=1", {
        headers: { Authorization: `Bearer ${resendKey}` },
      }, 5000);
      if (response.ok) return { status: "Connected", detail: "API auth success" };
      if (response.status === 401) return { status: "Auth Failed", detail: "Invalid API key" };
      return { status: "Error", detail: `HTTP ${response.status}` };
    } catch (err) {
      return { status: "Error", detail: err.message };
    }
  })();

  const hubspotCheck = (async () => {
    if (looksPlaceholder(hubspotToken)) {
      return { status: "Not Configured", detail: "Set HUBSPOT_ACCESS_TOKEN" };
    }
    try {
      const response = await fetchWithTimeout("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }, 5000);
      if (response.ok) return { status: "Connected", detail: "API auth success" };
      if (response.status === 401) return { status: "Auth Failed", detail: "Invalid access token" };
      return { status: "Error", detail: `HTTP ${response.status}` };
    } catch (err) {
      return { status: "Error", detail: err.message };
    }
  })();

  const ngrokCheck = (async () => {
    if (!ngrokDomain || looksPlaceholder(ngrokDomain)) {
      return { status: "Not Configured", detail: "Set NGROK_STATIC_DOMAIN" };
    }
    try {
      const response = await fetchWithTimeout(`${ngrokDomain.replace(/\/$/, "")}/health`, {}, 4000);
      if (response.ok) return { status: "Active", detail: "Tunnel responding" };
      return { status: "Unreachable", detail: `HTTP ${response.status}` };
    } catch (err) {
      return { status: "Unreachable", detail: err.message };
    }
  })();

  const [resendApi, hubspotApi, ngrokTunnel] = await Promise.all([resendCheck, hubspotCheck, ngrokCheck]);

  const webhook = webhookStatus();

  return {
    resendApi,
    hubspotApi,
    webhookServer: {
      status: webhook.running ? "Running" : "Stopped",
      detail: webhook.running ? `PID ${webhook.pid ?? "unknown"}` : "Start webhook from UI",
    },
    ngrokTunnel,
    signatureVerify: {
      status: enforceSignature
        ? secretConfigured
          ? "Enabled"
          : "Misconfigured"
        : secretConfigured
          ? "Configured (Permissive)"
          : "Disabled",
      detail: enforceSignature
        ? "Strict request verification"
        : "Verification not enforced",
    },
  };
}

app.get("/api/env", (_req, res) => {
  const parsed = parseEnvValues();
  const values = {};
  for (const key of ENV_KEYS) values[key] = parsed[key] ?? "";
  res.json({ ok: true, values });
});

app.post("/api/env", (req, res) => {
  const input = req.body?.values;
  if (!input || typeof input !== "object") {
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  const updates = {};
  for (const key of ENV_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== "string") {
      res.status(400).json({ ok: false, error: `invalid_value_type_${key}` });
      return;
    }
    if (value.includes("\n") || value.includes("\r")) {
      res.status(400).json({ ok: false, error: `invalid_newline_in_${key}` });
      return;
    }
    updates[key] = value;
  }

  updateEnvFile(updates);
  res.json({ ok: true, saved: Object.keys(updates) });
});

app.post("/api/tasks/start", (req, res) => {
  try {
    const taskId = String(req.body?.taskId || "");
    const session = startTask(taskId);
    res.json({ ok: true, session: serializeTaskSession(), started: session.sessionId });
  } catch (err) {
    const message = String(err.message || "task_start_failed");
    const code = message === "task_in_progress" ? 409 : 400;
    res.status(code).json({ ok: false, error: message, session: serializeTaskSession() });
  }
});

app.get("/api/tasks/session", (_req, res) => {
  res.json({ ok: true, session: serializeTaskSession() });
});

app.get("/api/webhook/status", (_req, res) => {
  res.json({ ok: true, ...webhookStatus() });
});

app.post("/api/webhook/start", (_req, res) => {
  const started = startWebhook();
  res.json({ ok: true, started, ...webhookStatus() });
});

app.post("/api/webhook/stop", async (_req, res) => {
  const stopped = await stopWebhook();
  res.json({ ok: true, stopped, ...webhookStatus() });
});

app.get("/api/campaign/state", (_req, res) => {
  res.json({ ok: true, ...campaignStateForUi() });
});

app.get("/api/delivery", (_req, res) => {
  if (!fs.existsSync(DELIVERY_FILE)) {
    res.json({ ok: true, exists: false, data: null, raw: "" });
    return;
  }

  const raw = fs.readFileSync(DELIVERY_FILE, "utf-8");
  const data = readJsonFile(DELIVERY_FILE, null);
  res.json({ ok: true, exists: true, data, raw });
});

app.get("/api/system/status", async (_req, res) => {
  const report = await systemStatusReport();
  res.json({ ok: true, report, checked_at: nowIso() });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(uiDir, "index.html"));
});

app.listen(port, () => {
  console.log(`UI running at http://localhost:${port}`);
  console.log(`Workspace root: ${rootDir}`);
});
