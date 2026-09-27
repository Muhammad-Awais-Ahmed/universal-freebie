"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";
import {
  FolderOpen,
  SlidersHorizontal,
  Network,
  RefreshCw,
  Zap,
  CheckCircle2,
  Save,
  Loader2,
  HardDrive,
  Bot,
  Package,
  Rocket,
  Trash2,
  Download,
  CircleCheck,
  CircleAlert
} from "lucide-react";

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
  const [autoInstallEnabled, setAutoInstallEnabled] = useState(false);
  const [autoInstallDependencies, setAutoInstallDependencies] = useState(true);
  const [autoLaunchInstaller, setAutoLaunchInstaller] = useState(true);
  const [autoDeleteAfterInstall, setAutoDeleteAfterInstall] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "latest" | "outdated" | "error">("idle");
  const [appVersion, setAppVersion] = useState("...");

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
      // Best effort: an older main process may not expose this handler yet.
      ipcRenderer.invoke("app:version").then(
        (info: { version?: string }) => {
          if (info && info.version) setAppVersion(info.version);
        },
        () => {}
      );
      if (settings) {
        setDownloadDir(settings.downloadDirectory || "...");
        setMaxConcurrent(settings.maxConcurrent || 50);
        setMaxChunks(settings.maxChunks || 64);
        setProxyPoolEnabled(!!settings.proxyPoolEnabled);
        setAutoInstallEnabled(!!settings.autoInstallEnabled);
        setAutoInstallDependencies(settings.autoInstallDependencies !== false);
        setAutoLaunchInstaller(settings.autoLaunchInstaller !== false);
        setAutoDeleteAfterInstall(!!settings.autoDeleteAfterInstall);
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
        autoInstallEnabled,
        autoInstallDependencies,
        autoLaunchInstaller,
        autoDeleteAfterInstall,
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

  // Updates are no longer checked on startup, so this is the only way to ask
  // for one. The main process only opens the update screen when the published
  // release really is newer than this build, so an up-to-date install simply
  // reports "latest" here without interrupting the user.
  const checkForUpdates = async () => {
    setUpdateStatus("checking");
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const result = await ipcRenderer.invoke("update:check-latest");
      if (!result || result.status === "error") {
        setUpdateStatus("error");
      } else if (result.status === "available") {
        setUpdateStatus("outdated");
      } else {
        setUpdateStatus("latest");
      }
    } catch (err) {
      console.error("Failed to check for updates:", err);
      setUpdateStatus("error");
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>System Settings</h1>
        <p className={styles.subtitle}>
          Configure storage destinations, chunk concurrency, and multi-source peer acceleration.
        </p>
      </div>

      <div className={styles.sections}>
        {/* Storage Location */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <HardDrive className="w-4 h-4 text-red-500" />
            Storage Destination
          </h2>
          <div className={styles.field}>
            <label className={styles.label}>Game Download Directory</label>
            <div className={styles.inputRow}>
              <input
                type="text"
                className={styles.input}
                value={downloadDir}
                readOnly
              />
              <button className={styles.browseBtn} onClick={chooseFolder}>
                <FolderOpen className="w-3.5 h-3.5" />
                Browse
              </button>
            </div>
          </div>
        </div>

        {/* Download Concurrency */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <SlidersHorizontal className="w-4 h-4 text-blue-500" />
            Chunk & Connection Tuning
          </h2>
          <div className={styles.field}>
            <label className={styles.label}>
              Max Concurrent Downloads: <span className="text-red-400 font-mono font-bold">{maxConcurrent}</span>
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
              Parallel Chunks Per File: <span className="text-blue-400 font-mono font-bold">{maxChunks}</span>
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

        {/* Proxy Peer Acceleration */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <Network className="w-4 h-4 text-red-500" />
            Proxy Pool (Multi-Peer Acceleration)
          </h2>
          <div className={styles.field}>
            <label className={`${styles.label} flex items-center cursor-pointer select-none`}>
              <input
                type="checkbox"
                checked={proxyPoolEnabled}
                onChange={(e) => setProxyPoolEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-red-600 focus:ring-red-500 mr-2.5"
              />
              <span className="text-slate-100 font-medium">
                Enable free GitHub open-source proxy pool
              </span>
            </label>
            <p className={styles.proxyNote}>
              Automatically aggregates public HTTP/SOCKS endpoints, pings them with ultra-low latency test probes, and routes file chunk requests through fast peers in parallel.
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
                {proxyStatus?.inReserve ? `${proxyStatus.inReserve.toLocaleString()} reserve` : "Total loaded"}
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
                {proxyStatus ? `${proxyStatus.workingCount} live + ${proxyStatus.staleRemoved} dead` : "Evaluated"}
              </div>
            </div>

            <div className={styles.proxyMetricCard}>
              <div className={`${styles.proxyMetricVal} ${proxyStatus && proxyStatus.workingCount > 0 ? styles.proxyMetricValSuccess : ""}`}>
                {proxyStatus?.workingCount || 0}
              </div>
              <div className={styles.proxyMetricLabel}>Verified Fast</div>
              <div className={styles.proxyMetricSublabel}>Active peers</div>
            </div>

            <div className={styles.proxyMetricCard}>
              <div className={`${styles.proxyMetricVal} ${proxyStatus && proxyStatus.staleRemoved > 0 ? styles.proxyMetricValWarn : ""}`}>
                {proxyStatus?.staleRemoved || 0}
              </div>
              <div className={styles.proxyMetricLabel}>Pruned Stale</div>
              <div className={styles.proxyMetricSublabel}>Timed out</div>
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
              {refreshingProxies ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching GitHub…
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" /> Fetch & Refresh Pool
                </>
              )}
            </button>

            <button
              type="button"
              className={styles.actionBtnSecondary}
              onClick={validateProxyPool}
              disabled={refreshingProxies || validatingProxies || !proxyPoolEnabled}
            >
              {validatingProxies ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Validating…
                </>
              ) : (
                <>
                  <Zap className="w-3.5 h-3.5" /> Validate & Prune Stale
                </>
              )}
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
              : "Click 'Fetch & Refresh Pool' to load free open-source proxies."}
          </div>

          {/* Top Working Proxies Preview */}
          {proxyStatus && proxyStatus.proxies && proxyStatus.proxies.length > 0 && (
            <div className={styles.proxyChipsContainer}>
              <div className={styles.proxyChipsTitle}>Verified Low-Latency Peer Nodes</div>
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

        {/* AI Automatic Installation */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <Bot className="w-4 h-4 text-emerald-500" />
            AI Automatic Installation
          </h2>

          <div className={styles.field}>
            <label className={`${styles.label} flex items-center cursor-pointer select-none`}>
              <input
                type="checkbox"
                checked={autoInstallEnabled}
                onChange={(e) => setAutoInstallEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500 mr-2.5"
              />
              <span className="text-slate-100 font-medium">
                Install games automatically when a download finishes
              </span>
            </label>
            <p className={styles.proxyNote}>
              The AI inspects the finished download, picks the real installer, and starts it for you.
              Games are only ever touched inside your download folder. No account or API key is
              needed.
            </p>
          </div>

          {autoInstallEnabled && (
            <>
              <div className={styles.field}>
                <label className={`${styles.label} flex items-center cursor-pointer select-none`}>
                  <input
                    type="checkbox"
                    checked={autoInstallDependencies}
                    onChange={(e) => setAutoInstallDependencies(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500 mr-2.5"
                  />
                  <span className="text-slate-100 font-medium flex items-center gap-2">
                    <Package className="w-3.5 h-3.5" />
                    Install missing prerequisites first
                  </span>
                </label>
                <p className={styles.proxyNote}>
                  Detects Visual C++ Redistributable, DirectX and .NET on this machine and silently
                  installs only the ones that are actually missing, using a bundled copy when the
                  download ships one.
                </p>
              </div>

              <div className={styles.field}>
                <label className={`${styles.label} flex items-center cursor-pointer select-none`}>
                  <input
                    type="checkbox"
                    checked={autoLaunchInstaller}
                    onChange={(e) => setAutoLaunchInstaller(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500 mr-2.5"
                  />
                  <span className="text-slate-100 font-medium flex items-center gap-2">
                    <Rocket className="w-3.5 h-3.5" />
                    Launch the game installer
                  </span>
                </label>
              </div>

              <div className={styles.field}>
                <label className={`${styles.label} flex items-center cursor-pointer select-none`}>
                  <input
                    type="checkbox"
                    checked={autoDeleteAfterInstall}
                    onChange={(e) => setAutoDeleteAfterInstall(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500 mr-2.5"
                  />
                  <span className="text-slate-100 font-medium flex items-center gap-2">
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete downloaded files after installation
                  </span>
                </label>
                <p className={styles.proxyNote}>
                  Removes the archive and the extracted files once the installer exits. If the
                  installer is still running, the files are kept. The installed game is never deleted.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Application Updates */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <Download className="w-4 h-4 text-cyan-500" />
            Application Updates
          </h2>
          <div className={styles.field}>
            <label className={styles.label}>
              Installed version: <span className="text-cyan-400 font-mono font-bold">v{appVersion}</span>
            </label>
            <p className={styles.proxyNote}>
              This app never checks for updates on its own and never interrupts you at
              startup. Click below to ask GitHub whether a newer release has been
              published. If one exists, the update screen opens and you choose what
              happens next.
            </p>
          </div>

          <div className={styles.proxyActionsRow}>
            <button
              type="button"
              className={styles.actionBtnPrimary}
              onClick={checkForUpdates}
              disabled={updateStatus === "checking"}
            >
              {updateStatus === "checking" ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" /> Check for Updates
                </>
              )}
            </button>
          </div>

          {updateStatus === "latest" && (
            <div className={styles.proxyTimestamp}>
              <CircleCheck className="w-3.5 h-3.5 inline mr-1.5 text-emerald-400" />
              You are on the latest version. Nothing to install.
            </div>
          )}
          {updateStatus === "outdated" && (
            <div className={styles.proxyTimestamp}>
              <Download className="w-3.5 h-3.5 inline mr-1.5 text-cyan-400" />
              A newer release is available. The update screen has been opened for you.
            </div>
          )}
          {updateStatus === "error" && (
            <div className={styles.proxyTimestamp}>
              <CircleAlert className="w-3.5 h-3.5 inline mr-1.5 text-amber-400" />
              Could not reach GitHub to check for updates. Try again in a moment.
            </div>
          )}
        </div>

        {/* Save Settings Trigger */}
        <button
          className={styles.saveBtn}
          onClick={saveSettings}
          disabled={saving}
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Saving Configuration…
            </>
          ) : (
            <>
              <Save className="w-4 h-4" /> Save System Settings
            </>
          )}
        </button>
      </div>
    </div>
  );
}
