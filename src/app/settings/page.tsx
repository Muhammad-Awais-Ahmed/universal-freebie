"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";

interface ProxyStatus {
  enabled: boolean;
  updating: boolean;
  validating: boolean;
  totalLoaded: number;
  testedCount?: number;
  inReserve?: number;
  workingCount: number;
  staleRemoved: number;
  fastestLatency: number | null;
  avgLatency: number | null;
  lastUpdatedAt: number | null;
  lastValidated: number | null;
  lastError: string | null;
  sourcesCount: number;
  proxies: { host: string; port: number; latency: number }[];
}

export default function SettingsPage() {
  const [downloadDir, setDownloadDir] = useState("...");
  const [maxConcurrent, setMaxConcurrent] = useState(50);
  const [maxChunks, setMaxChunks] = useState(64);
  const [proxyPoolEnabled, setProxyPoolEnabled] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshingProxies, setRefreshingProxies] = useState(false);
  const [validatingProxies, setValidatingProxies] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const [settings, proxy] = await Promise.all([
        ipcRenderer.invoke("get-settings"),
        ipcRenderer.invoke("get-proxy-status"),
      ]);
      if (settings) {
        setDownloadDir(settings.downloadDirectory || "...");
        setMaxConcurrent(settings.maxConcurrent || 50);
        setMaxChunks(settings.maxChunks || 64);
        setProxyPoolEnabled(!!settings.proxyPoolEnabled);
      }
      if (proxy) setProxyStatus(proxy);
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

  const validateProxyPool = async () => {
    setValidatingProxies(true);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const status = await ipcRenderer.invoke("validate-proxy-pool");
      setProxyStatus(status);
    } catch (err) {
      console.error("Failed to validate proxies:", err);
    } finally {
      setValidatingProxies(false);
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
              Downloads free public proxies from 12+ open-source GitHub repositories, tests them with tiny ping requests, and routes
              download chunks through the fastest working ones — acting as extra parallel
              peers for much higher download speed.
            </p>
          </div>

          {/* Proxy Metrics Dashboard */}
          <div className={styles.proxyMetricsGrid}>
            <div className={styles.proxyMetricCard}>
              <div className={styles.proxyMetricVal}>
                {proxyStatus?.totalLoaded ? proxyStatus.totalLoaded.toLocaleString() : "0"}
              </div>
              <div className={styles.proxyMetricLabel}>GitHub Pool</div>
              <div className={styles.proxyMetricSublabel}>
                {proxyStatus?.inReserve ? `${proxyStatus.inReserve.toLocaleString()} in reserve` : "Total loaded"}
              </div>
            </div>

            <div className={styles.proxyMetricCard}>
              <div className={styles.proxyMetricVal}>
                {proxyStatus?.testedCount
                  ? proxyStatus.testedCount.toLocaleString()
                  : proxyStatus
                  ? (proxyStatus.workingCount + proxyStatus.staleRemoved).toLocaleString()
                  : "0"}
              </div>
              <div className={styles.proxyMetricLabel}>Tested Batch</div>
              <div className={styles.proxyMetricSublabel}>
                {proxyStatus ? `${proxyStatus.workingCount} live + ${proxyStatus.staleRemoved} dead` : "Ping evaluated"}
              </div>
            </div>

            <div className={styles.proxyMetricCard}>
              <div className={`${styles.proxyMetricVal} ${proxyStatus && proxyStatus.workingCount > 0 ? styles.proxyMetricValSuccess : ""}`}>
                {proxyStatus?.workingCount || 0}
              </div>
              <div className={styles.proxyMetricLabel}>Verified Working</div>
              <div className={styles.proxyMetricSublabel}>Active fast peers</div>
            </div>

            <div className={styles.proxyMetricCard}>
              <div className={`${styles.proxyMetricVal} ${proxyStatus && proxyStatus.staleRemoved > 0 ? styles.proxyMetricValWarn : ""}`}>
                {proxyStatus?.staleRemoved || 0}
              </div>
              <div className={styles.proxyMetricLabel}>Stale Removed</div>
              <div className={styles.proxyMetricSublabel}>Timed out / dead</div>
            </div>

            <div className={styles.proxyMetricCard}>
              <div className={styles.proxyMetricVal}>
                {proxyStatus?.fastestLatency ? `${proxyStatus.fastestLatency}ms` : "—"}
              </div>
              <div className={styles.proxyMetricLabel}>Fastest Ping</div>
              <div className={styles.proxyMetricSublabel}>
                {proxyStatus?.avgLatency ? `Avg: ${proxyStatus.avgLatency}ms` : "Latency"}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className={styles.proxyActionsRow}>
            <button
              type="button"
              className={styles.actionBtnPrimary}
              onClick={refreshProxyPool}
              disabled={refreshingProxies || validatingProxies || !proxyPoolEnabled}
            >
              {refreshingProxies ? "⏳ Fetching from GitHub…" : "🌐 Fetch & Refresh from GitHub"}
            </button>

            <button
              type="button"
              className={styles.actionBtnSecondary}
              onClick={validateProxyPool}
              disabled={refreshingProxies || validatingProxies || !proxyPoolEnabled}
            >
              {validatingProxies ? "⚡ Validating & Pruning…" : "⚡ Validate Proxies & Remove Stale"}
            </button>
          </div>

          {/* Timestamp status */}
          <div className={styles.proxyTimestamp}>
            {refreshingProxies
              ? "Fetching candidate proxies from GitHub and testing fastest peers…"
              : validatingProxies
              ? "Validating active proxies and pruning dead/stale endpoints…"
              : proxyStatus?.lastValidated
              ? `Last validated: ${new Date(proxyStatus.lastValidated).toLocaleTimeString()}`
              : proxyStatus?.totalLoaded
              ? "Proxies loaded. Click Validate to prune stale ones."
              : "Click 'Fetch & Refresh from GitHub' to load free open-source proxies."}
          </div>

          {/* Top Working Proxies Preview */}
          {proxyStatus && proxyStatus.proxies && proxyStatus.proxies.length > 0 && (
            <div className={styles.proxyChipsContainer}>
              <div className={styles.proxyChipsTitle}>Top Verified Fast Proxies</div>
              <div className={styles.proxyChipsList}>
                {proxyStatus.proxies.map((p, idx) => (
                  <div key={idx} className={styles.proxyChip}>
                    <span>{p.host}:{p.port}</span>
                    <span
                      className={
                        p.latency < 300
                          ? styles.latencyFast
                          : p.latency < 600
                          ? styles.latencyMed
                          : styles.latencySlow
                      }
                    >
                      {p.latency}ms
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
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
