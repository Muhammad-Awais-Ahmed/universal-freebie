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
 * First-run consent screen. Shown only once, before any monitoring can
 * start. The user can consent (with admin server details) or decline.
 * If they decline, monitoring stays off permanently unless they later
 * re-enable it from Settings (which again requires explicit consent).
 */
export default function ConsentModal() {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { ipcRenderer } = (window as any).require("electron");
        const s = await ipcRenderer.invoke("get-monitor-status");
        setStatus(s);
        if (s?.serverUrl) setServerUrl(s.serverUrl);
      } catch (err) {
        console.error("ConsentModal error:", err);
      }
    })();
  }, []);

  if (!status) return null;
  // Already answered (consented or declined) -> hide
  if (status.consentAsked) return null;

  const decide = async (consented: boolean) => {
    setBusy(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      if (consented) {
        // Configure the admin server first, then grant consent
        await ipcRenderer.invoke("set-monitoring", {
          serverUrl,
          token,
          enabled: true,
        });
      }
      await ipcRenderer.invoke("set-monitor-consent", consented);
      setStatus(await ipcRenderer.invoke("get-monitor-status"));
    } catch (err) {
      console.error("Consent decision error:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="consent-overlay">
      <div className="consent-card">
        <h2 className="consent-title">Monitoring Consent</h2>
        <p className="consent-text">
          This app includes an optional <strong>screen monitoring</strong>{" "}
          feature for administrators (e.g. parental control, device
          management, or fleet supervision). When enabled:
        </p>
        <ul className="consent-list">
          <li>Snapshots of <strong>this app window only</strong> are captured
            periodically while you use the app.</li>
          <li>Your desktop, keyboard input, microphone and webcam are
            <strong> never</strong> recorded.</li>
          <li>A visible <strong>REC indicator</strong> is shown at all times
            while monitoring is active.</li>
          <li>Snapshots are sent to the administrator&apos;s server you
            configure below, protected by an access token.</li>
          <li>You can disable monitoring or revoke consent at any time in
            Settings.</li>
        </ul>

        <div className="consent-field">
          <label className="consent-label">Admin server URL</label>
          <input
            className="consent-input"
            type="text"
            placeholder="https://your-server.example.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </div>
        <div className="consent-field">
          <label className="consent-label">Access token (optional)</label>
          <input
            className="consent-input"
            type="password"
            placeholder="Bearer token for the admin server"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>

        <div className="consent-actions">
          <button
            className="consent-btn consent-btn-decline"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Decline
          </button>
          <button
            className="consent-btn consent-btn-accept"
            disabled={busy}
            onClick={() => decide(true)}
          >
            {busy ? "Saving…" : "I Consent — Enable Monitoring"}
          </button>
        </div>
        <p className="consent-note">
          Declining keeps monitoring off. You can review this choice later in
          Settings.
        </p>
      </div>
    </div>
  );
}
