"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import styles from "./DownloadManager.module.css";
import { formatNumericBytes } from "@/utils/formatters";
import { DownloadCloud, ChevronDown, ChevronUp, Square, RotateCcw, X, FolderOpen, Bot, Play, Trash2, Gamepad2, Check } from "lucide-react";

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

// Phases after which the game is on disk and can be registered in the library.
const LIBRARY_READY_PHASES = new Set([
  "installed",
  "cleaned",
  "awaiting-manual-install"
]);

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
    case "interrupted":
      return "Paused";
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
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

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

  // A finished download is NOT dismissed on a timer any more. It used to
  // vanish 5s after completing, which meant the Install button was on screen
  // for a few seconds at most and was effectively impossible to click (and
  // the backend evicted the item from its map ~30s later anyway, so there was
  // nothing to install even if you did). Completed rows now stay until the
  // user acts on them: install, add to library, or explicitly dismiss.
  const dismissItem = useCallback((id: string) => {
    setCompletedTimer((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const invoke = (channel: string, ...args: unknown[]) => {
    if (window.require) {
      const { ipcRenderer } = window.require("electron");
      return ipcRenderer.invoke(channel, ...args);
    }
  };

  const filtered = downloads.filter(
    (d) => d.status !== "cancelled" && !completedTimer[d.id]
  );

  // Runs the AI install pipeline for a finished download and then registers the
  // installed game in the library. The pipeline emits its own progress events,
  // so this only has to kick it off and surface the outcome.
  const installAndRegister = useCallback(async (id: string) => {
    setInstallingId(id);
    setNotice("");
    try {
      const res = await invoke("run-auto-install", id);
      if (res && res.ok === false) {
        setNotice(res.error || "Installation could not start.");
      } else {
        setNotice("Installer started. The game is added to your library once it finishes.");
      }
    } catch (err) {
      console.error("Install failed:", err);
      setNotice("Installation could not start.");
    } finally {
      setInstallingId(null);
    }
  }, [invoke]);

  // Registers an already-installed download in the library without re-running
  // the installer. `detect-installed-game` finds the real game executable, so
  // the entry that lands in the library is launchable rather than the archive.
  const addToLibrary = useCallback(async (id: string) => {
    setLibraryId(id);
    setNotice("");
    try {
      const res = await invoke("add-download-to-library", id);
      if (res && res.ok) {
        setNotice(`Added "${res.game?.name || "game"}" to your library.`);
      } else {
        setNotice(res?.error || "No game executable was found in this download.");
      }
    } catch (err) {
      console.error("Add to library failed:", err);
      setNotice("Could not add this download to your library.");
    } finally {
      setLibraryId(null);
    }
  }, [invoke]);

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
          {notice && <div className={styles.notice}>{notice}</div>}
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
                    {/* A paused/stalled transfer was previously rendered as a
                        dead row: the backend used to emit a 'paused' status
                        that no condition matched, so a stopped download showed
                        neither Stop nor Retry. Interrupted now maps to Retry,
                        matching the status the rest of the app uses. */}
                    {item.status === "interrupted" && (
                      <button
                        className={styles.retryBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("resume-download", item.id);
                        }}
                      >
                        <RotateCcw className="w-3 h-3" /> Resume
                      </button>
                    )}
                    {item.status === "completed" && !auto && (
                      <button
                        className={styles.retryBtn}
                        title="Let the AI install this game"
                        onClick={(e) => {
                          e.stopPropagation();
                          installAndRegister(item.id);
                        }}
                      >
                        {installingId === item.id ? (
                          <RotateCcw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}{" "}
                        Install
                      </button>
                    )}
                    {/* Offered once the pipeline reports the game is on disk.
                        Kept visible even after the run so a manual retry is
                        always one click away. */}
                    {item.status === "completed" && auto && LIBRARY_READY_PHASES.has(auto.phase) && (
                      <button
                        className={styles.retryBtn}
                        title="Find the game executable and add it to your library"
                        onClick={(e) => {
                          e.stopPropagation();
                          addToLibrary(item.id);
                        }}
                      >
                        {libraryId === item.id ? (
                          <RotateCcw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Gamepad2 className="w-3 h-3" />
                        )}{" "}
                        Add to Library
                      </button>
                    )}
                    {(item.status === "error" || item.status === "completed" || item.status === "interrupted") && (
                      <button
                        className={styles.cancelBtn}
                        title={
                          item.status === "completed"
                            ? "Dismiss from list"
                            : "Remove from list"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("remove-download", item.id);
                          dismissItem(item.id);
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
