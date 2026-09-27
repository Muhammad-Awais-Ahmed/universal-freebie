"use client";

import { useState, useEffect, useRef } from "react";
import styles from "./DownloadManager.module.css";
import { formatNumericBytes } from "@/utils/formatters";
import { DownloadCloud, ChevronDown, ChevronUp, Square, RotateCcw, X, FolderOpen, Bot, Play, Trash2 } from "lucide-react";

interface DownloadItem {
  id: string;
  filename: string;
  status: string;
  progress: number;
  speed: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

interface AutoInstallState {
  downloadId: string;
  phase: string;
  message?: string;
  error?: string;
  filename?: string;
  updatedAt: number;
  removed?: string[];
  dependenciesInstalled?: string[];
  dependenciesFailed?: string[];
}

// Phases that mean work is still happening — the row must not auto-dismiss.
const ACTIVE_PHASES = new Set([
  "planning",
  "installer-found",
  "dependencies",
  "dependency",
  "dependency-download",
  "dependency-installing",
  "installing",
  "cleaned"
]);

function isActiveInstall(state?: AutoInstallState | null): boolean {
  if (!state) return false;
  if (ACTIVE_PHASES.has(state.phase)) return true;
  // A success that still has pending dependency work is not "done" yet.
  return state.phase === "dependencies-done" && (state.dependenciesFailed?.length ?? 0) > 0;
}

const PHASE_LABELS: Record<string, string> = {
  planning: "AI is choosing the installer",
  "installer-found": "Installer identified",
  dependencies: "Checking prerequisites",
  dependency: "Installing prerequisite",
  "dependency-download": "Downloading prerequisite",
  "dependency-installing": "Setting up prerequisite",
  "dependencies-done": "Prerequisites ready",
  installing: "Installing game",
  cleaned: "Done — files removed",
  installed: "Installer started",
  skipped: "No installer found",
  "awaiting-manual-install": "Start it yourself",
  "cleanup-skipped": "Files kept",
  error: "Auto-install failed"
};

function formatBytes(bytes: number, decimals = 2): string {
  return formatNumericBytes(bytes, decimals);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getStatusText(item: DownloadItem, auto?: AutoInstallState | null): string {
  if (auto && auto.phase !== "planning") {
    return PHASE_LABELS[auto.phase] || auto.phase;
  }
  switch (item.status) {
    case "error":
      return item.error || "Failed";
    case "completed":
      return "Completed ✓";
    case "cancelled":
      return "Cancelled";
    case "queued":
      return "Queued";
    default:
      return `${formatBytes(item.speed)}/s`;
  }
}

export default function DownloadManager() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const isVisibleRef = useRef(false);
  const [completedTimer, setCompletedTimer] = useState<Record<string, number>>({});
  const [autoInstall, setAutoInstall] = useState<Record<string, AutoInstallState>>({});

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.require) return;
    const { ipcRenderer } = window.require("electron");
    const handler = (_event: unknown, data: DownloadItem[]) => {
      setDownloads(data);
      if (data.length > 0 && !isVisibleRef.current) {
        setIsVisible(true);
      }
    };
    const installHandler = (_event: unknown, state: AutoInstallState) => {
      if (!state || !state.downloadId) return;
      setAutoInstall((prev) => ({ ...prev, [state.downloadId]: state }));
      if (!isVisibleRef.current) setIsVisible(true);
    };
    ipcRenderer.on("downloads-progress", handler);
    ipcRenderer.on("auto-install-progress", installHandler);
    return () => {
      ipcRenderer.removeListener("downloads-progress", handler);
      ipcRenderer.removeListener("auto-install-progress", installHandler);
    };
  }, []);

  // Auto-dismiss completed items after 5s, but never while the AI installer
  // is still working on that download.
  useEffect(() => {
    const completed = downloads.filter(
      (d) => d.status === "completed" && !isActiveInstall(autoInstall[d.id])
    );
    if (completed.length === 0) return;

    const interval = setInterval(() => {
      setCompletedTimer((prev) => {
        const now = Date.now();
        const updated = { ...prev };
        let changed = false;
        for (const item of completed) {
          if (!updated[item.id]) {
            updated[item.id] = now;
            changed = true;
          } else if (now - updated[item.id] > 5000) {
            delete updated[item.id];
            changed = true;
          }
        }
        return changed ? updated : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [downloads, autoInstall]);

  const invoke = (channel: string, ...args: unknown[]) => {
    if (window.require) {
      const { ipcRenderer } = window.require("electron");
      return ipcRenderer.invoke(channel, ...args);
    }
  };

  const filtered = downloads.filter(
    (d) => d.status !== "cancelled" && !completedTimer[d.id]
  );

  const activeCount = filtered.filter(
    (d) => d.status === "downloading" || d.status === "queued"
  ).length;

  if (!isVisible && filtered.length === 0) return null;

  return (
    <div className={`${styles.container} ${isVisible ? styles.visible : ""}`}>
      <div className={styles.header} onClick={() => setIsVisible(!isVisible)}>
        <h3 className={styles.title}>
          <span className={styles.icon}>
            <DownloadCloud className="w-4 h-4 text-red-500" />
          </span>
          <span>Downloads</span>
          {activeCount > 0 && (
            <span className={styles.badgeActive}>{activeCount} ACTIVE</span>
          )}
        </h3>
        <button className={styles.toggleBtn} title={isVisible ? "Minimize" : "Expand"}>
          {isVisible ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>

      {isVisible && (
        <div className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No active downloads in queue</div>
          ) : (
            filtered.map((item) => {
              const auto = autoInstall[item.id];
              const busy = isActiveInstall(auto);
              return (
              <div key={item.id} className={styles.downloadItem}>
                <div className={styles.itemHeader}>
                  <div className={styles.itemName} title={item.filename}>
                    {item.filename}
                  </div>
                  <div className={styles.itemStatus}>
                    {getStatusText(item, auto)}
                  </div>
                </div>

                <div className={styles.progressContainer}>
                  <div
                    className={`${styles.progressBar} ${
                      auto?.phase === "error"
                        ? styles.progressBarError
                        : busy
                        ? styles.progressBarInstalling
                        : styles[`progressBar${capitalize(item.status)}`] || ""
                    }`}
                    style={{ width: `${item.progress}%` }}
                  />
                </div>

                {auto && (
                  <div
                    className={`${styles.autoInstallRow} ${
                      auto.phase === "error" ? styles.autoInstallRowError : ""
                    }`}
                  >
                    <span className={styles.autoInstallIcon}>
                      {auto.phase === "error" ? (
                        <X className="w-3 h-3" />
                      ) : (
                        <Bot className={`w-3 h-3 ${busy ? styles.autoInstallPulse : ""}`} />
                      )}
                    </span>
                    <span className={styles.autoInstallText} title={auto.error || auto.message}>
                      {auto.error || auto.message || PHASE_LABELS[auto.phase] || auto.phase}
                    </span>
                    {auto.removed && auto.removed.length > 0 && (
                      <span className={styles.autoInstallMeta}>
                        <Trash2 className="w-3 h-3" />
                        {auto.removed.length}
                      </span>
                    )}
                  </div>
                )}

                <div className={styles.itemDetails}>
                  <span className={styles.sizeInfo}>
                    {formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}
                  </span>
                  <div className={styles.actions}>
                    {item.status === "downloading" && (
                      <button
                        className={styles.cancelBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("cancel-download", item.id);
                        }}
                      >
                        <Square className="w-3 h-3" /> Stop
                      </button>
                    )}
                    {item.status === "error" && (
                      <button
                        className={styles.retryBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("resume-download", item.id);
                        }}
                      >
                        <RotateCcw className="w-3 h-3" /> Retry
                      </button>
                    )}
                    {item.status === "completed" && !auto && (
                      <button
                        className={styles.retryBtn}
                        title="Let the AI install this game"
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("run-auto-install", item.id);
                        }}
                      >
                        <Play className="w-3 h-3" /> Install
                      </button>
                    )}
                    {(item.status === "error" || item.status === "completed") && (
                      <button
                        className={styles.cancelBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("remove-download", item.id);
                        }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              );
            })
          )}
          <button
            className={styles.openFolderBtn}
            onClick={() => invoke("open-download-dir")}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open Downloads Folder
          </button>
        </div>
      )}
    </div>
  );
}
