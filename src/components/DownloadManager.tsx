"use client";

import { useState, useEffect, useRef } from "react";
import styles from "./DownloadManager.module.css";
import { formatNumericBytes } from "@/utils/formatters";

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

function formatBytes(bytes: number, decimals = 2): string {
  return formatNumericBytes(bytes, decimals);
}

function getStatusText(item: DownloadItem): string {
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
    ipcRenderer.on("downloads-progress", handler);
    return () => {
      ipcRenderer.removeListener("downloads-progress", handler);
    };
  }, []);

  // Auto-dismiss completed items after 5s
  useEffect(() => {
    const completed = downloads.filter((d) => d.status === "completed");
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
  }, [downloads]);

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
          <span className={styles.icon}>⬇️</span>
          Downloads ({activeCount} Active)
        </h3>
        <button className={styles.toggleBtn}>{isVisible ? "▼" : "▲"}</button>
      </div>
      {isVisible && (
        <div className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No active downloads</div>
          ) : (
            filtered.map((item) => (
              <div key={item.id} className={styles.downloadItem}>
                <div className={styles.itemHeader}>
                  <div className={styles.itemName} title={item.filename}>
                    {item.filename}
                  </div>
                  <div className={styles.itemStatus}>
                    {getStatusText(item)}
                  </div>
                </div>
                <div className={styles.progressContainer}>
                  <div
                    className={`${styles.progressBar} ${styles[item.status] || ""}`}
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
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
                        ✕ Cancel
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
                        🔄 Retry
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
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
