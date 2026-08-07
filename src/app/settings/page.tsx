"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";

interface MonitorStatus {
  active: boolean;
  consentAsked: boolean;
  consented: boolean;
  enabled: boolean;
  serverUrl: string;
  intervalMs: number;
  lastSentAt: string | null;
}

interface ProxyStatus {
  enabled: boolean;
  updating: boolean;
  proxies: { host: string; port: number; latency: number }[];
  lastUpdatedAt: number | null;
  lastError: string | null;
  totalCandidates: number;
  tested: number;
}

export default function SettingsPage() {
  const [downloadDir, setDownloadDir] = useState("...");
  const [maxConcurrent, setMaxConcurrent] = useState(50);
  const [maxChunks, setMaxChunks] = useState(64);
  const [webtorrentTrackers, setWebtorrentTrackers] = useState("");
  const [proxyPoolEnabled, setProxyPoolEnabled] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshingProxies, setRefreshingProxies] = useState(false);

  // Monitoring state
  const [monitor, setMonitor] = useState<MonitorStatus | null>(null);
  const [monServerUrl, setMonServerUrl] = useState("");
  const [monToken, setMonToken] = useState("");
  const [monInterval, setMonInterval] = useState(15);
  const [monSaving, setMonSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const [settings, m, proxy] = await Promise.all([
        ipcRenderer.invoke("get-settings"),
        ipcRenderer.invoke("get-monitor-status"),
        ipcRenderer.invoke("get-proxy-status"),
      ]);
      if (settings) {
        setDownloadDir(settings.downloadDirectory || "...");
        setMaxConcurrent(settings.maxConcurrent || 50);
        setMaxChunks(settings.maxChunks || 64);
        setWebtorrentTrackers(settings.webtorrentTrackers || "");
        setProxyPoolEnabled(!!settings.proxyPoolEnabled);
      }
      if (proxy) setProxyStatus(proxy);
      if (m) {
        setMonitor(m);
        setMonServerUrl(m.serverUrl || "");
        setMonInterval(Math.round((m.intervalMs || 15000) / 1000));
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  };

  const refreshProxyPool = async () => {
    setRefreshingProxies(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const status = await ipcRenderer.invoke("refresh-proxy-pool");
      setProxyStatus(status);
    } catch (err) {
      console.error("Failed to refresh proxy pool:", err);
    } finally {
      setRefreshingProxies(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("save-settings", {
        downloadDirectory: downloadDir,
        maxConcurrent,
        maxChunks,
        webtorrentTrackers,
        proxyPoolEnabled,
      });
      const proxy = await ipcRenderer.invoke("get-proxy-status");
      if (proxy) setProxyStatus(proxy);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

  const chooseFolder = async () => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const folder = await ipcRenderer.invoke("choose-download-dir");
      if (folder) {
        setDownloadDir(folder);
      }
    } catch (err) {
      console.error("Failed to choose folder:", err);
    }
  };

  const saveMonitoring = async (enabled?: boolean) => {
    setMonSaving(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const m = await ipcRenderer.invoke("set-monitoring", {
        serverUrl: monServerUrl,
        token: monToken,
        intervalMs: monInterval * 1000,
        enabled: enabled !== undefined ? enabled : monitor?.enabled,
      });
      setMonitor(m);
    } catch (err) {
      console.error("Failed to save monitoring settings:", err);
    } finally {
      setMonSaving(false);
    }
  };

  const revokeConsent = async () => {
    setMonSaving(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const m = await ipcRenderer.invoke("set-monitor-consent", false);
      setMonitor(m);
    } catch (err) {
      console.error("Failed to revoke consent:", err);
    } finally {
      setMonSaving(false);
    }
  };

  const grantConsent = async () => {
    setMonSaving(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("set-monitoring", {
        serverUrl: monServerUrl,
        token: monToken,
        intervalMs: monInterval * 1000,
        enabled: true,
      });
      const m = await ipcRenderer.invoke("set-monitor-consent", true);
      setMonitor(m);
    } catch (err) {
      console.error("Failed to grant consent:", err);
    } finally {
      setMonSaving(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>Configure download and application settings</p>
      </div>

      <div className={styles.sections}>
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>📁 Download Location</h2>
          <div className={styles.field}>
            <label className={styles.label}>Download Directory</label>
            <div className={styles.inputRow}>
              <input
                type="text"
                className={styles.input}
                value={downloadDir}
                readOnly
              />
              <button className={styles.browseBtn} onClick={chooseFolder}>
                Browse
              </button>
            </div>
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>⚡ Download Settings</h2>
          <div className={styles.field}>
            <label className={styles.label}>
              Max Concurrent Downloads: {maxConcurrent}
            </label>
            <input
              type="range"
              min="1"
              max="200"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(parseInt(e.target.value))}
              className={styles.slider}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>
              Download Chunks (per file): {maxChunks}
            </label>
            <input
              type="range"
              min="8"
              max="128"
              step="8"
              value={maxChunks}
              onChange={(e) => setMaxChunks(parseInt(e.target.value))}
              className={styles.slider}
            />
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>🌐 Proxy Pool (Parallel Peers)</h2>
          <div className={styles.field}>
            <label className={styles.label}>
              <input
                type="checkbox"
                checked={proxyPoolEnabled}
                onChange={(e) => setProxyPoolEnabled(e.target.checked)}
                style={{ marginRight: 8, transform: "scale(1.3)" }}
              />
              Enable free proxy pool from GitHub
            </label>
            <p className={styles.monitorNote}>
              Downloads free public proxies from GitHub lists, tests them, and routes
              every chunk through the fastest working ones — acting as extra parallel
              peers for much higher speed.
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Proxy Pool Status</label>
            <div className={styles.inputRow}>
              <input
                type="text"
                className={styles.input}
                readOnly
                value={
                  proxyStatus?.updating
                    ? "Testing proxies…"
                    : proxyStatus && proxyStatus.proxies && proxyStatus.proxies.length > 0
                    ? `${proxyStatus.proxies.length} working proxies (fastest: ${proxyStatus.proxies[0].host}:${proxyStatus.proxies[0].port}, ${proxyStatus.proxies[0].latency}ms)`
                    : proxyStatus?.lastError
                    ? `No proxies yet — ${proxyStatus.lastError}`
                    : "No proxies loaded yet"
                }
              />
              <button
                className={styles.browseBtn}
                onClick={refreshProxyPool}
                disabled={refreshingProxies || !proxyPoolEnabled}
              >
                {refreshingProxies ? "Testing…" : "Refresh Pool"}
              </button>
            </div>
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>🌐 WebTorrent Trackers</h2>
          <div className={styles.field}>
            <label className={styles.label}>Additional tracker URLs (one per line)</label>
            <textarea
              className={styles.textarea}
              rows={4}
              value={webtorrentTrackers}
              onChange={(e) => setWebtorrentTrackers(e.target.value)}
              placeholder="udp://tracker.opentrackr.org:1337/announce&#10;udp://open.stealth.si:80/announce"
            />
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>📊 Monitoring Settings</h2>
          <div className={styles.field}>
            <label className={styles.label}>Monitoring Server URL</label>
            <div className={styles.inputRow}>
              <input
                type="text"
                className={styles.input}
                value={monServerUrl}
                readOnly
              />
              <button className={styles.browseBtn} onClick={chooseFolder}>
                Browse
              </button>
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Monitoring Interval (seconds)</label>
            <input
              type="range"
              min="5"
              max="30"
              value={monInterval}
              onChange={(e) => setMonInterval(parseInt(e.target.value))}
              className={styles.slider}
            />
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>🛡️ Monitoring &amp; Privacy</h2>

          <div className={styles.monitorStatusRow}>
            <span className={`${styles.monitorStatusBadge} ${monitor?.active ? styles.monitorActive : ""}`}>
              {monitor?.active ? "● REC — Monitoring Active" : "○ Monitoring Off"}
            </span>
            <span className={styles.monitorConsent}>
              {monitor?.consented ? "Consent granted" : monitor?.consentAsked ? "Consent declined" : "Consent not asked yet"}
            </span>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Admin server URL (where snapshots are sent)</label>
            <input
              type="text"
              className={styles.input}
              value={monServerUrl}
              onChange={(e) => setMonServerUrl(e.target.value)}
              placeholder="https://your-server.example.com"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Access token</label>
            <input
              type="password"
              className={styles.input}
              value={monToken}
              onChange={(e) => setMonToken(e.target.value)}
              placeholder="Bearer token for the admin server"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>
              Snapshot interval: {monInterval} seconds
            </label>
            <input
              type="range"
              min="5"
              max="120"
              step="5"
              value={monInterval}
              onChange={(e) => setMonInterval(parseInt(e.target.value))}
              className={styles.slider}
            />
          </div>

          <div className={styles.monitorActions}>
            {monitor?.consented ? (
              <>
                <button
                  className={styles.browseBtn}
                  onClick={() => saveMonitoring(!monitor.enabled)}
                  disabled={monSaving}
                >
                  {monitor.enabled ? "Disable Monitoring" : "Enable Monitoring"}
                </button>
                <button
                  className={styles.dangerBtn}
                  onClick={revokeConsent}
                  disabled={monSaving}
                >
                  Revoke Consent
                </button>
              </>
            ) : (
              <>
                <button
                  className={styles.browseBtn}
                  onClick={grantConsent}
                  disabled={monSaving}
                >
                  Grant Consent &amp; Enable
                </button>
                <button
                  className={styles.browseBtn}
                  onClick={() => saveMonitoring(false)}
                  disabled={monSaving}
                >
                  Save Settings
                </button>
              </>
            )}
          </div>

          <p className={styles.monitorNote}>
            Only this app&apos;s window is captured — never your desktop, keyboard,
            mic, or camera. A visible REC badge is shown while active. You can
            revoke consent anytime.
          </p>
        </div>

        <button
          className={styles.saveBtn}
          onClick={saveSettings}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
