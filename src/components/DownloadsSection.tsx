"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./DownloadsSection.module.css";
import { formatNumericBytes } from "@/utils/formatters";
import { DownloadCloud, Play, Square, FolderOpen, X, Loader2, HardDrive } from "lucide-react";

interface HistoryItem {
  id: string;
  filename: string;
  url?: string;
  totalBytes?: number;
  downloadedBytes?: number;
  source?: string;
  status: string;
  dateStarted?: string;
  dateCompleted?: string | null;
}

interface LiveItem extends HistoryItem {
  progress: number;
  speed: number;
  error?: string;
}

function formatBytes(bytes: number, decimals = 2): string {
  return formatNumericBytes(bytes, decimals);
}

function formatSpeed(speed: number): string {
  if (!speed) return "";
  return `${formatBytes(speed)}/s`;
}

function getStatusText(item: HistoryItem): string {
  switch (item.status) {
    case "downloading":
      return "Downloading…";
    case "queued":
      return "Queued";
    case "interrupted":
    case "error":
      return "Paused / Incomplete";
    case "completed":
      return "Completed ✓";
    case "cancelled":
      return "Cancelled";
    default:
      return item.status;
  }
}

export default function DownloadsSection() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const invoke = useCallback((channel: string, ...args: unknown[]) => {
    if (window.require) {
      const { ipcRenderer } = window.require("electron");
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.resolve(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [history, downloadDir] = await Promise.all([
        invoke("get-download-history"),
        invoke("get-download-dir"),
      ]);
      setItems(Array.isArray(history) ? history : []);
      if (typeof downloadDir === "string") setDir(downloadDir);
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live overlay: merge in-memory download state on top of history entries.
  useEffect(() => {
    if (typeof window === "undefined" || !window.require) return;
    const { ipcRenderer } = window.require("electron");
    const handler = (_e: unknown, live: LiveItem[]) => {
      if (!Array.isArray(live)) return;
      setItems((prev) => {
        const map = new Map(prev.map((p) => [p.id, p]));
        for (const d of live) {
          map.set(d.id, { ...map.get(d.id), ...d });
        }
        return Array.from(map.values());
      });
    };
    ipcRenderer.on("downloads-progress", handler);
    return () => ipcRenderer.removeListener("downloads-progress", handler);
  }, []);

  const continueDownload = async (id: string) => {
    setBusyId(id);
    setNotice("");
    const res = await invoke("continue-download", id);
    setBusyId(null);
    if (res && res.error) setNotice(res.error);
    else await refresh();
  };

  const cancelDownload = async (id: string) => {
    await invoke("cancel-download", id);
    await refresh();
  };

  const removeDownload = async (id: string) => {
    await invoke("remove-download", id);
    await refresh();
  };

  const openFile = (filename: string) => {
    if (!dir) return;
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "\\";
    invoke("open-folder", `${dir}${sep}${filename}`);
  };

  const activeCount = items.filter(
    (i) => i.status === "downloading" || i.status === "queued"
  ).length;

  const partialCount = items.filter(
    (i) => i.status === "interrupted" || i.status === "error" || i.status === "cancelled"
  ).length;

  const progressOf = (item: HistoryItem): number => {
    if (item.totalBytes) {
      return Math.min(100, ((item.downloadedBytes || 0) / item.totalBytes) * 100);
    }
    return (item as LiveItem).progress || 0;
  };

  const isPartial = (item: HistoryItem) =>
    ["interrupted", "error", "cancelled"].includes(item.status);

  const isActive = (item: HistoryItem) =>
    ["downloading", "queued"].includes(item.status);

  return (
    <section className={styles.section} id="downloads">
      <div className={styles.heading}>
        <div>
          <div className={styles.titleWrapper}>
            <DownloadCloud className="w-5 h-5 text-red-500" />
            <h2 className={styles.title}>Active & Recent Downloads</h2>
          </div>
          <p className={styles.subtitle}>
            Incomplete downloads are auto-preserved and can be resumed with peer acceleration.
          </p>
        </div>
        {(activeCount > 0 || partialCount > 0) && (
          <div className={styles.chips}>
            {activeCount > 0 && (
              <span className={`${styles.chip} ${styles.chipActive}`}>
                {activeCount} Active
              </span>
            )}
            {partialCount > 0 && (
              <span className={`${styles.chip} ${styles.chipPartial}`}>
                {partialCount} Incomplete
              </span>
            )}
          </div>
        )}
      </div>

      {notice && <div className={styles.notice}>{notice}</div>}

      {loading ? (
        <div className={styles.empty}>Loading downloads…</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <HardDrive className="w-10 h-10 stroke-[1.5]" />
          </div>
          <p>No active downloads in queue.</p>
          <p className={styles.emptySub}>
            Search for a game and hit Download — chunk progress will track here in real time.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => {
            const progress = progressOf(item);
            const live = item as LiveItem;
            return (
              <div key={item.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <div className={styles.nameBlock}>
                    <div className={styles.name} title={item.filename}>
                      {item.filename}
                    </div>
                    <div className={styles.meta}>
                      <span className={styles.source}>
                        {item.source || "Direct"}
                      </span>
                      <span
                        className={`${styles.status} ${
                          isActive(item)
                            ? styles.statusActive
                            : isPartial(item)
                            ? styles.statusPartial
                            : item.status === "completed"
                            ? styles.statusDone
                            : ""
                        }`}
                      >
                        {getStatusText(item)}
                      </span>
                    </div>
                  </div>
                  <div className={styles.sizeInfo}>
                    {formatBytes(item.downloadedBytes || 0)} /{" "}
                    {formatBytes(item.totalBytes || 0)}
                    {live.speed ? (
                      <span className={styles.speed}>
                        {" "}
                        · {formatSpeed(live.speed)}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className={styles.progressContainer}>
                  <div
                    className={`${styles.progressBar} ${
                      item.status === "completed" ? styles.progressDone : ""
                    } ${isPartial(item) ? styles.progressPartial : ""}`}
                    style={{ width: `${progress}%` }}
                  />
                </div>

                <div className={styles.cardBottom}>
                  <span className={styles.pct}>{Math.round(progress)}%</span>
                  <div className={styles.actions}>
                    {isActive(item) && (
                      <button
                        className={styles.actionBtn}
                        onClick={() => cancelDownload(item.id)}
                      >
                        <Square className="w-3 h-3 text-rose-400" /> Cancel
                      </button>
                    )}
                    {isPartial(item) && (
                      <button
                        className={styles.continueBtn}
                        disabled={busyId === item.id}
                        onClick={() => continueDownload(item.id)}
                      >
                        {busyId === item.id ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" /> Resuming…
                          </>
                        ) : (
                          <>
                            <Play className="w-3 h-3 fill-current" /> Continue
                          </>
                        )}
                      </button>
                    )}
                    {item.status === "completed" && (
                      <button
                        className={styles.actionBtn}
                        onClick={() => openFile(item.filename)}
                      >
                        <FolderOpen className="w-3 h-3 text-cyan-400" /> Open Folder
                      </button>
                    )}
                    <button
                      className={styles.removeBtn}
                      title="Remove from list"
                      onClick={() => removeDownload(item.id)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
