"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";
import { formatBytes, formatNumericBytes } from "@/utils/formatters";
import {
  Gamepad2,
  DownloadCloud,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCcw,
  ExternalLink,
  Folder,
  Play
} from "lucide-react";

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
        <h1 className={styles.title}>Game Library</h1>
        <p className={styles.subtitle}>
          Launch installed titles, review download history, and manage local storage files.
        </p>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === "installed" ? styles.activeTab : ""}`}
          onClick={() => setTab("installed")}
        >
          <Gamepad2 className="w-4 h-4" />
          <span>Installed Games</span>
          <span className={styles.tabBadge}>{installed.length}</span>
        </button>

        <button
          className={`${styles.tab} ${tab === "downloads" ? styles.activeTab : ""}`}
          onClick={() => setTab("downloads")}
        >
          <DownloadCloud className="w-4 h-4" />
          <span>Download History</span>
          <span className={styles.tabBadge}>{history.length}</span>
        </button>

        <button
          className={`${styles.tab} ${tab === "browse" ? styles.activeTab : ""}`}
          onClick={() => setTab("browse")}
        >
          <FolderOpen className="w-4 h-4" />
          <span>Storage Explorer</span>
        </button>
      </div>

      <div className={styles.content}>
        {tab === "installed" && (
          <>
            {installed.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>
                  <Gamepad2 className="w-12 h-12 stroke-[1.5]" />
                </div>
                <h3>No installed games detected</h3>
                <p>Your downloads folder doesn't contain recognized game executables yet.</p>
                <div className={styles.dirPath}>{downloadDir}</div>
                <div>
                  <button className={styles.openBtn} onClick={() => openFolder()}>
                    <FolderOpen className="w-4 h-4" />
                    Open Downloads Folder
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.list}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                  <button className={styles.openBtn} style={{ marginTop: 0 }} onClick={() => openFolder()}>
                    <FolderOpen className="w-4 h-4" />
                    Open Downloads Folder
                  </button>
                </div>
                {installed.map((game, i) => (
                  <div
                    key={i}
                    className={styles.listItem}
                    onClick={() => openFolder(game.executablePath)}
                  >
                    <div className={styles.listIconWrapper}>
                      <Gamepad2 className="w-5 h-5" />
                    </div>
                    <div className={styles.listInfo}>
                      <h4>{game.name}</h4>
                      <p>{game.executablePath}</p>
                    </div>
                    {game.size && (
                      <span className={styles.listSize}>
                        {formatBytes(game.size)}
                      </span>
                    )}
                    <button
                      className={styles.openBtn}
                      style={{ marginTop: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFolder(game.executablePath);
                      }}
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      Launch
                    </button>
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
                <div className={styles.emptyIcon}>
                  <DownloadCloud className="w-12 h-12 stroke-[1.5]" />
                </div>
                <h3>No download history</h3>
                <p>Files downloaded through Universal Freebie will be recorded here.</p>
              </div>
            ) : (
              <div className={styles.list}>
                {history.map((item, i) => (
                  <div key={item.id || i} className={styles.listItem}>
                    <div className={styles.listIconWrapper}>
                      {item.status === "completed" ? (
                        <CheckCircle2 className="w-5 h-5 text-blue-400" />
                      ) : item.status === "error" ? (
                        <AlertCircle className="w-5 h-5 text-red-500" />
                      ) : (
                        <Clock className="w-5 h-5 text-sky-400" />
                      )}
                    </div>
                    <div className={styles.listInfo}>
                      <h4>{item.filename}</h4>
                      <p>
                        {item.source || "Direct"} • {formatNumericBytes(item.totalBytes)}
                      </p>
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
                          <RotateCcw className="w-3.5 h-3.5" />
                          Resume
                        </button>
                      )}
                      <span className={styles.listDate}>
                        {item.dateCompleted ? new Date(item.dateCompleted).toLocaleDateString() : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "browse" && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Folder className="w-12 h-12 stroke-[1.5]" />
            </div>
            <h3>Downloads Directory</h3>
            <p>Physical storage location where game packages are assembled:</p>
            <div className={styles.dirPath}>{downloadDir}</div>
            <div>
              <button className={styles.openBtn} onClick={() => openFolder()}>
                <ExternalLink className="w-4 h-4" />
                Open in Windows Explorer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
