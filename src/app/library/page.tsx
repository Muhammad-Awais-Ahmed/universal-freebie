"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";
import { formatBytes, formatNumericBytes } from "@/utils/formatters";

type Tab = "installed" | "downloads" | "browse";

interface InstalledGame {
  name: string;
  executablePath: string;
  size?: string;
}

interface DownloadHistoryItem {
  id: string;
  filename: string;
  source: string;
  totalBytes: number;
  dateCompleted: string;
  status: string;
}

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("installed");
  const [installed, setInstalled] = useState<InstalledGame[]>([]);
  const [history, setHistory] = useState<DownloadHistoryItem[]>([]);
  const [downloadDir, setDownloadDir] = useState("...");

  useEffect(() => {
    loadLibrary();
  }, []);

  const loadLibrary = async () => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const dir = await ipcRenderer.invoke("get-download-dir");
      setDownloadDir(dir);
      const inst = await ipcRenderer.invoke("get-installed-games");
      setInstalled(inst || []);
      const hist = await ipcRenderer.invoke("get-download-history");
      setHistory(hist || []);
    } catch (err) {
      console.error("Failed to load library:", err);
    }
  };

  const openFolder = async (path?: string) => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      if (path) {
        await ipcRenderer.invoke("open-folder", path);
      } else {
        await ipcRenderer.invoke("open-download-dir");
      }
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Library</h1>
        <p className={styles.subtitle}>Manage your downloaded games</p>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === "installed" ? styles.activeTab : ""}`}
          onClick={() => setTab("installed")}
        >
          📁 Installed Games ({installed.length})
        </button>
        <button
          className={`${styles.tab} ${tab === "downloads" ? styles.activeTab : ""}`}
          onClick={() => setTab("downloads")}
        >
          📥 Download History ({history.length})
        </button>
        <button
          className={`${styles.tab} ${tab === "browse" ? styles.activeTab : ""}`}
          onClick={() => setTab("browse")}
        >
          🔍 Browse Folder
        </button>
      </div>

      <div className={styles.content}>
        {tab === "installed" && (
          <>
            {installed.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>📁</div>
                <h3>No installed games</h3>
                <p>Your downloads directory is empty or no games have been detected.</p>
                <p className={styles.dirPath}>{downloadDir}</p>
                <button className={styles.openBtn} onClick={() => openFolder()}>
                  Open Downloads Folder
                </button>
              </div>
            ) : (
              <div className={styles.list}>
                {installed.map((game, i) => (
                  <div key={i} className={styles.listItem} onClick={() => openFolder(game.executablePath)}>
                    <div className={styles.listIcon}>🎮</div>
                    <div className={styles.listInfo}>
                      <h4>{game.name}</h4>
                      <p>{game.executablePath}</p>
                    </div>
                    {game.size && <span className={styles.listSize}>{formatBytes(game.size)}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "downloads" && (
          <>
            {history.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>📥</div>
                <h3>No download history</h3>
                <p>Your download history will appear here.</p>
              </div>
            ) : (
              <div className={styles.list}>
                {history.map((item, i) => (
                  <div key={item.id || i} className={styles.listItem}>
                    <div className={styles.listIcon}>
                      {item.status === "completed" ? "✅" : item.status === "error" ? "❌" : "⏳"}
                    </div>
                    <div className={styles.listInfo}>
                      <h4>{item.filename}</h4>
                      <p>{item.source} • {formatNumericBytes(item.totalBytes)}</p>
                    </div>
                    <div className={styles.listActions}>
                      {item.status === "error" && (
                        <button
                          className={styles.retryBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            const { ipcRenderer } = (window as any).require("electron");
                            ipcRenderer.invoke("resume-download", item.id);
                          }}
                        >
                          🔄 Continue
                        </button>
                      )}
                      <span className={styles.listDate}>{item.dateCompleted ? new Date(item.dateCompleted).toLocaleDateString() : ''}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "browse" && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>📂</div>
            <h3>Downloads Folder</h3>
            <p>{downloadDir}</p>
            <button className={styles.openBtn} onClick={() => openFolder()}>
              Open in Explorer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
