"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Mic, PhoneCall, RotateCcw, SendHorizonal, Square } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GodsCrewLogo } from "@/components/gods-crew-logo";
import { formatDuration } from "@/lib/utils";

const DEFAULT_PROSPECT_ID = "00000000-0000-0000-0000-000000000000";

type ToolName =
  | "send_payment_email"
  | "log_objection"
  | "schedule_followup"
  | "confirm_payment"
  | "mark_do_not_call";

type SpeechRecognitionResultLike = {
  0?: {
    transcript?: string;
  };
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
};

type SpeechRecognitionInstance = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

type VoiceWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type VoiceMessage = {
  id: string;
  role: "agent" | "user" | "system";
  text: string;
  timestamp: string;
};

type CallsResponse = {
  data: Array<{ duration_seconds: number | null; outcome: string | null; summary: string | null }> | null;
  error: string | null;
  count: number | null;
};

type DashboardResponse = {
  ok: boolean;
  summary: {
    prospects_total: number;
    prospects_closed: number;
  };
};

function speechCtor() {
  if (typeof window === "undefined") return null;
  const w = window as VoiceWindow;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function detectVoiceTool(input: string): { tool: ToolName; args: Record<string, unknown> } | null {
  const lower = input.toLowerCase();
  const email = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email && (lower.includes("payment") || lower.includes("checkout") || lower.includes("link"))) {
    return { tool: "send_payment_email", args: { email } };
  }
  if (lower.includes("confirm payment") || lower.includes("paid")) return { tool: "confirm_payment", args: {} };
  if (lower.includes("follow up") || lower.includes("callback")) {
    return { tool: "schedule_followup", args: { suggested_time: "tomorrow 2pm", reason: "Voice callback request" } };
  }
  if (lower.includes("do not call") || lower.includes("stop calling")) return { tool: "mark_do_not_call", args: {} };
  if (lower.includes("budget") || lower.includes("expensive")) {
    return { tool: "log_objection", args: { type: "too_expensive", verbatim: input } };
  }
  return null;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AgentPage() {
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "speaking" | "listening">("idle");
  const [active, setActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [messages, setMessages] = useState<VoiceMessage[]>([
    {
      id: makeId("msg"),
      role: "system",
      text: "Agent ready. Start a test call to simulate a live prospect conversation.",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("+14155550123");
  const [avgDuration, setAvgDuration] = useState("-");
  const [objectionRate, setObjectionRate] = useState("0%");
  const [closeRate, setCloseRate] = useState("0%");
  const [topObjection, setTopObjection] = useState("We already have someone (0)");

  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const callIdRef = useRef(`test-call-${Date.now()}`);

  const pitchPreview = `Hello, this is Adam from God's Cleaning Crew.
We help properties eliminate surprise biohazard cleanup costs with an annual protection plan.
If this sounds useful, I can send a payment link right now and stay on the line while you complete checkout.`;

  const addMessage = (role: VoiceMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { id: makeId("msg"), role, text, timestamp: new Date().toISOString() }]);
  };

  const setPhase = (next: typeof status) => setStatus(next);

  const runTool = async (tool: ToolName, args: Record<string, unknown>) => {
    const payload = {
      message: {
        type: "tool-calls",
        call: {
          id: callIdRef.current,
          customer: { number: phoneNumber.trim() || "+14155550123" },
          metadata: { prospect_id: DEFAULT_PROSPECT_ID, phone: phoneNumber.trim() || "+14155550123" },
        },
        toolCallList: [
          {
            id: makeId("tc"),
            type: "function",
            function: { name: tool, arguments: JSON.stringify(args) },
          },
        ],
      },
    };

    const response = await fetch("/api/vapi/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw || "{}");
      return parsed.results?.[0]?.result || parsed.result || "Command executed.";
    } catch {
      return raw || "Command executed.";
    }
  };

  const handleUserInput = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    addMessage("user", value);
    setBusy(true);
    setPhase("listening");

    try {
      const detected = detectVoiceTool(value);
      if (!detected) {
        const fallback =
          "I can help with objections, follow-ups, payment links, and do-not-call requests. Tell me what the prospect said.";
        addMessage("agent", fallback);
        setPhase("speaking");
        return;
      }

      const reply = await runTool(detected.tool, detected.args);
      setPhase("speaking");
      addMessage("agent", String(reply || "Action completed."));
    } catch (error) {
      addMessage("system", error instanceof Error ? error.message : "Agent action failed.");
      toast.error(error instanceof Error ? error.message : "Agent action failed.");
    } finally {
      setBusy(false);
      window.setTimeout(() => setPhase(active ? "listening" : "idle"), 700);
    }
  };

  const startTest = () => {
    if (active) return;
    setActive(true);
    setSeconds(0);
    setPhase("connecting");
    addMessage("system", "Connecting to Adam...");

    window.setTimeout(() => {
      setPhase("speaking");
      addMessage(
        "agent",
        "Hey, this is Adam from God's Cleaning Crew. We protect condo and hotel properties from unexpected biohazard cleanup costs. Do you have 30 seconds?"
      );
    }, 800);

    window.setTimeout(() => setPhase("listening"), 1800);
  };

  const endTest = () => {
    if (recRef.current && micOn) {
      recRef.current.stop();
      setMicOn(false);
    }
    setActive(false);
    setPhase("idle");
    addMessage("system", "Test call ended.");
  };

  const startMic = () => {
    const Ctor = speechCtor();
    if (!Ctor) {
      toast.error("Speech recognition is not supported in this browser.");
      return;
    }
    if (!active) {
      toast.error("Start a test call first.");
      return;
    }

    if (!recRef.current) {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (event: SpeechRecognitionEventLike) => {
        const transcript = Array.from(event.results || []).map((r) => r[0]?.transcript || "").join(" ");
        void handleUserInput(transcript);
      };
      rec.onerror = () => {
        setMicOn(false);
      };
      rec.onend = () => setMicOn(false);
      recRef.current = rec;
    }
    setMicOn(true);
    recRef.current.start();
  };

  const testWithPhone = async () => {
    const e164 = /^\+[1-9]\d{6,14}$/;
    if (!e164.test(phoneNumber.trim())) {
      toast.error("Phone number must be valid E.164.");
      return;
    }
    try {
      const prospectsRes = await fetch("/api/dashboard/prospects?page=1&pageSize=1&sortBy=created_at&sortDirection=desc", {
        cache: "no-store",
      });
      const prospectsPayload = await prospectsRes.json();
      const firstProspect = prospectsPayload?.data?.[0];
      if (!prospectsRes.ok || !firstProspect?.id) {
        throw new Error("Add at least one prospect before testing with phone.");
      }

      const response = await fetch("/api/dashboard/call-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospect_id: firstProspect.id,
          phone: phoneNumber.trim(),
          contact_name: firstProspect.contact_name || "Operator Test",
        }),
      });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error || "Failed to place test phone call.");
      toast.success("Phone test call initiated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to place test phone call.");
    }
  };

  const resetConversation = () => {
    setMessages([
      {
        id: makeId("msg"),
        role: "system",
        text: "Conversation reset. Start a new test when ready.",
        timestamp: new Date().toISOString(),
      },
    ]);
    setDraft("");
    setSeconds(0);
    setActive(false);
    setPhase("idle");
  };

  const submitText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await handleUserInput(text);
  };

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  useEffect(() => {
    const loadPerformance = async () => {
      try {
        const [callsRes, dashboardRes] = await Promise.all([
          fetch("/api/dashboard/calls?page=1&limit=100&sortBy=created_at&sortDirection=desc", { cache: "no-store" }),
          fetch("/api/dashboard", { cache: "no-store" }),
        ]);

        const callsPayload = (await callsRes.json()) as CallsResponse;
        const dashboardPayload = (await dashboardRes.json()) as DashboardResponse;

        if (callsRes.ok && callsPayload.data) {
          const durations = callsPayload.data.map((call) => Number(call.duration_seconds || 0)).filter((value) => value > 0);
          const avg = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0;
          setAvgDuration(formatDuration(avg));

          const objectionSignals = callsPayload.data.filter((call) =>
            (call.summary || "").toLowerCase().includes("objection")
          ).length;
          const handledSignals = callsPayload.data.filter(
            (call) => (call.summary || "").toLowerCase().includes("resolved") || (call.outcome || "").toLowerCase() === "closed"
          ).length;
          const objectionPct =
            objectionSignals > 0 ? Math.round((Math.min(handledSignals, objectionSignals) / objectionSignals) * 100) : 0;
          setObjectionRate(`${objectionPct}%`);

          const buckets: Record<string, number> = {
            "We already have someone": 0,
            "Too expensive": 0,
            "Not interested": 0,
          };
          for (const call of callsPayload.data) {
            const summary = (call.summary || "").toLowerCase();
            if (summary.includes("already have")) buckets["We already have someone"] += 1;
            if (summary.includes("expensive") || summary.includes("budget")) buckets["Too expensive"] += 1;
            if (summary.includes("not interested")) buckets["Not interested"] += 1;
          }
          const top = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0];
          setTopObjection(`${top[0]} (${top[1]})`);
        }

        if (dashboardRes.ok && dashboardPayload.ok) {
          const total = dashboardPayload.summary.prospects_total || 0;
          const closed = dashboardPayload.summary.prospects_closed || 0;
          setCloseRate(total > 0 ? `${Math.round((closed / total) * 100)}%` : "0%");
        }
      } catch {
        // Non-fatal stats failures should not block the panel.
      }
    };

    void loadPerformance();
    const id = window.setInterval(() => void loadPerformance(), 30000);
    return () => window.clearInterval(id);
  }, []);

  const timerLabel = useMemo(
    () => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
    [seconds]
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold text-white">Agent</h1>
        <p className="text-sm text-[var(--text-muted)]">Configure Adam and run live voice tests before production dialing.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Profile</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Name</p>
                <p>Adam</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Company</p>
                <p>God&apos;s Cleaning Crew</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Voice</p>
                <p>Cartesia</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Model</p>
                <p>Groq Llama 3.1 70B</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2 md:col-span-2">
                <p className="text-xs text-[var(--text-muted)]">Status</p>
                <div className="mt-1 flex items-center gap-2 text-[#9dffcf]">
                  <span className="pulse-dot h-2.5 w-2.5 rounded-full bg-[var(--green)]" />
                  Active
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="items-center">
              <CardTitle>Pitch Script Preview</CardTitle>
              <Button onClick={() => setScriptExpanded((prev) => !prev)} size="sm" variant="outline">
                {scriptExpanded ? "Hide Full Script" : "View Full Script"}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="rounded-2xl border border-[var(--line)] bg-[rgba(255,255,255,0.03)] p-3 text-xs leading-relaxed text-[#b8d9ef]">
                {scriptExpanded
                  ? `${pitchPreview}

If the prospect is interested:
- Collect email address
- Trigger send_payment_email
- Handle objections naturally
- Confirm payment completion before ending call
- Respect do-not-call requests immediately`
                  : pitchPreview}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Performance Stats</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Average call duration</p>
                <p className="text-lg text-white">{avgDuration}</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Objection handling rate</p>
                <p className="text-lg text-white">{objectionRate}</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Close rate</p>
                <p className="text-lg text-white">{closeRate}</p>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
                <p className="text-xs text-[var(--text-muted)]">Top objection</p>
                <p className="text-white">{topObjection}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader className="items-center">
            <CardTitle>Test Agent</CardTitle>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  status === "idle"
                    ? "bg-[var(--text-muted)]"
                    : status === "connecting"
                      ? "bg-[var(--amber)]"
                      : status === "speaking"
                        ? "bg-[var(--cyan)] pulse-dot"
                        : "bg-[var(--green)] pulse-dot"
                }`}
              />
              {status === "idle"
                ? "Ready"
                : status === "connecting"
                  ? "Connecting..."
                  : status === "speaking"
                    ? "Agent Speaking..."
                    : "Listening..."}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {active ? <p className="text-center text-sm text-[#a1d8ff]">{timerLabel}</p> : null}

            <div className="flex flex-col items-center">
              <button
                className="relative h-[150px] w-[150px] rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.03)]"
                onClick={startTest}
                type="button"
              >
                <span
                  className={`absolute inset-0 rounded-full bg-[conic-gradient(from_180deg,#38B6FF,#00D4FF,#0066CC,#38B6FF)] p-[3px] ${
                    active ? "ring-spin-fast" : "ring-spin"
                  }`}
                >
                  <span
                    className={`absolute inset-[3px] flex items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_20%,rgba(56,182,255,0.2),rgba(0,0,0,0.9))] ${
                      active ? "orb-active" : "orb-idle"
                    }`}
                  >
                    <GodsCrewLogo size={58} withGlow={active} />
                  </span>
                </span>
              </button>
              <p className="mt-3 text-sm text-[var(--text-muted)]">{active ? "Live test running" : "Click to Start Test Call"}</p>
            </div>

            {active ? (
              <div className="space-y-3">
                <div className="flex h-8 items-end justify-center gap-1">
                  {Array.from({ length: 7 }).map((_, index) => (
                    <span
                      className="wave-bar w-1 rounded-full bg-gradient-to-t from-[#38B6FF] to-[#00D4FF]"
                      key={index}
                      style={{ animationDelay: `${index * 120}ms` }}
                    />
                  ))}
                </div>
                <div className="flex justify-center">
                  <Button className="rounded-full px-6" onClick={endTest} variant="danger">
                    <Square className="mr-2 h-4 w-4" />
                    End Call
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="max-h-[280px] space-y-2 overflow-y-auto rounded-2xl border border-[var(--line)] bg-[rgba(255,255,255,0.02)] p-3">
              {messages.map((message) => (
                <div
                  className={`max-w-[85%] rounded-2xl border px-3 py-2 ${
                    message.role === "agent"
                      ? "ml-auto border-[#0f5aa7] bg-[rgba(56,182,255,0.18)] text-[#c6ecff]"
                      : message.role === "user"
                        ? "border-[var(--line)] bg-[rgba(255,255,255,0.05)] text-[var(--text-main)]"
                        : "mx-auto border-[rgba(255,184,0,0.35)] bg-[rgba(255,184,0,0.08)] text-[#ffd47a]"
                  }`}
                  key={message.id}
                >
                  <p className="text-sm">{message.text}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              ))}
            </div>

            <form className="flex gap-2" onSubmit={submitText}>
              <Input
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type a message to the agent..."
                value={draft}
              />
              <Button disabled={busy || !active} type="submit">
                <SendHorizonal className="h-4 w-4" />
              </Button>
            </form>

            <div className="grid grid-cols-1 gap-2">
              <div className="flex gap-2">
                <Input onChange={(event) => setPhoneNumber(event.target.value)} placeholder="+14155550123" value={phoneNumber} />
                <Button onClick={testWithPhone} variant="outline">
                  <PhoneCall className="mr-1 h-4 w-4" />
                  Test with Phone
                </Button>
              </div>
              <div className="flex gap-2">
                <Button disabled={!active || micOn} onClick={startMic} variant="outline">
                  <Mic className="mr-1 h-4 w-4" />
                  {micOn ? "Listening..." : "Use Microphone"}
                </Button>
                <Button onClick={resetConversation} variant="outline">
                  <RotateCcw className="mr-1 h-4 w-4" />
                  Reset Conversation
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
