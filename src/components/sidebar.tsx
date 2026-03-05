"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Bot, CalendarDays, CreditCard, Gauge, Phone, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { GodsCrewLogo } from "@/components/gods-crew-logo";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/dashboard/prospects", label: "Prospects", icon: Users },
  { href: "/dashboard/calls", label: "Calls", icon: Phone },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/agent", label: "Agent", icon: Bot },
  { href: "/dashboard/payments", label: "Payments", icon: CreditCard },
  { href: "/dashboard/followups", label: "Followups", icon: CalendarDays },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

type SidebarProps = {
  health: "ok" | "error";
};

export function Sidebar({ health }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const navigate = (href: string) => {
    if (pathname === href) return;
    router.push(href);
    // Fallback to hard navigation if client routing stalls.
    window.setTimeout(() => {
      if (window.location.pathname !== href) {
        window.location.assign(href);
      }
    }, 500);
  };

  return (
    <aside className="glass-card sticky top-0 flex h-screen w-72 shrink-0 flex-col rounded-none border-r border-l-0 border-y-0 border-[var(--line)] bg-[rgba(0,0,0,0.86)] px-4 py-5">
      <div className="mb-7 flex items-center gap-3 px-1">
        <GodsCrewLogo size={40} withGlow />
        <div>
          <p className="text-lg font-bold leading-none text-white" style={{ fontFamily: "var(--font-display)" }}>
            God&apos;s Crew
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">AI Voice Sales Platform</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1.5">
        {navItems.map((item) => {
          const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <Link
              className={cn(
                "group relative flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm text-[var(--text-muted)] transition-all duration-200 hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--text-main)]",
                active &&
                  "border-[var(--line-strong)] bg-[rgba(56,182,255,0.13)] text-[#b4e8ff] shadow-[inset_2px_0_0_0_#38B6FF]"
              )}
              href={item.href}
              key={item.href}
              onClick={() => navigate(item.href)}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
              {active ? <span className="absolute left-0 top-2 h-7 w-[3px] rounded-r-full bg-[#38B6FF]" /> : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[rgba(255,255,255,0.03)] p-3">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              health === "ok" ? "bg-[var(--green)] pulse-dot" : "bg-[var(--red)]"
            )}
          />
          <span className={health === "ok" ? "text-[#9dffcf]" : "text-[#ffabab]"}>
            {health === "ok" ? "All Systems Live" : "Issue Detected"}
          </span>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]" data-mono="true">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </aside>
  );
}
