"use client";

import { useEffect, useState } from "react";

interface MonitorStatus {
  active: boolean;
  consentAsked: boolean;
  consented: boolean;
  enabled: boolean;
  serverUrl: string;
  intervalMs: number;
  lastSentAt: string | null;
}

/**
 * Persistent, always-visible "REC" indicator shown whenever screen
 * monitoring is active. Cannot be hidden while monitoring runs.
 */
export default function MonitorBadge() {
  const [status, setStatus] = useState<MonitorStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const { ipcRenderer } = (window as any).require("electron");
        ipcRenderer.on("monitor-status", (_e: any, s: MonitorStatus) => {
          if (mounted) setStatus(s);
        });
        const s = await ipcRenderer.invoke("get-monitor-status");
        if (mounted) setStatus(s);
      } catch (err) {
        console.error("MonitorBadge error:", err);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  if (!status || !status.active) return null;

  return (
    <div
      className="monitor-badge"
      title="Screen monitoring is active. Disable it anytime in Settings."
    >
      <span className="monitor-badge-dot" />
      <span className="monitor-badge-text">REC</span>
      <span className="monitor-badge-sub">monitoring active</span>
    </div>
  );
}
