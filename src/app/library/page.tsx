"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import { formatBytes, formatYearDisplay } from "@/utils/formatters";
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
  Play,
  Plus,
  Trash2,
  FolderSearch,
  Loader2,
  X
} from "lucide-react";

type Tab = "installed" | "downloads" | "browse";

interface InstalledGame {
  id: string;
  name: string;
  executablePath: string;
  size?: string | null;
  year?: string | null;
  source?: string;
  thumbnail?: string | null;
  dateAdded?: string;
}

interface DownloadHistoryItem {
  id: string;
  filename: string;
  source: string;
  totalBytes: number;
  dateCompleted: string;
  status: string;
}

interface FolderEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("installed");
  const [installed, setInstalled] = useState<InstalledGame[]>([]);
  const [history, setHistory] = useState<DownloadHistoryItem[]>([]);
  const [downloadDir, setDownloadDir] = useState("...");
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPath, setAddPath] = useState("");
  const [addSize, setAddSize] = useState("");
  const [addYear, setAddYear] = useState("");
  const [addSource, setAddSource] = useState("Manual");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  const invoke = useCallback((channel: string, ...args: unknown[]) => {
    if (window.require) {
      const { ipcRenderer } = window.require("electron");
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.resolve(null);
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const dir = await invoke("get-download-dir");
      setDownloadDir(typeof dir === "string" ? dir : "...");
      const inst = await invoke("get-installed-games");
      setInstalled(Array.isArray(inst) ? inst : []);
      const hist = await invoke("get-download-history");
      setHistory(Array.isArray(hist) ? hist : []);
    } catch (err) {
      console.error("Failed to load library:", err);
    }
  }, [invoke]);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  const openFolder = async (path?: string) => {
    try {
      if (path) {
        await invoke("open-folder", path);
      } else {
        await invoke("open-download-dir");
      }
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  };

  const loadFolderContents = useCallback(async () => {
    setFolderLoading(true);
    try {
      const entries = await invoke("get-folder-contents");
      setFolderEntries(Array.isArray(entries) ? entries : []);
    } catch (err) {
      console.error("Failed to load folder contents:", err);
      setFolderEntries([]);
    } finally {
      setFolderLoading(false);
    }
  }, [invoke]);

  useEffect(() => {
    if (tab === "browse") loadFolderContents();
  }, [tab, loadFolderContents]);

  const deleteEntry = async (entry: FolderEntry) => {
    try {
      await invoke("delete-file", entry.path);
      await loadFolderContents();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const launchGame = async (game: InstalledGame) => {
    setLaunchingId(game.id);
    setNotice("");
    try {
      const res = await invoke("launch-game", game.executablePath);
      if (res && res.ok === false) {
        setNotice(res.error || "Failed to launch game.");
      }
    } catch (err) {
      console.error("Launch failed:", err);
      setNotice("Failed to launch game.");
    } finally {
      setLaunchingId(null);
    }
  };

  const removeGame = async (game: InstalledGame) => {
    try {
      await invoke("remove-installed-game", game.id);
      await loadLibrary();
    } catch (err) {
      console.error("Remove failed:", err);
    }
  };

  const pickExecutable = async () => {
    try {
      const res = await invoke("add-installed-game");
      if (res && res.ok) {
        setNotice(`Added "${res.game?.name || "game"}" to your library.`);
        await loadLibrary();
      }
    } catch (err) {
      console.error("Add game failed:", err);
    }
  };

  const saveManualGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim() || !addPath.trim()) {
      setNotice("Game name and executable path are required.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const res = await invoke("add-game-entry", {
        name: addName.trim(),
        executablePath: addPath.trim(),
        size: addSize.trim() || null,
        year: addYear.trim() || null,
        source: addSource.trim() || "Manual",
      });
      if (res && res.ok) {
        setNotice(`Added "${res.game?.name || addName}" to your library.`);
        setAddName("");
        setAddPath("");
        setAddSize("");
        setAddYear("");
        setAddSource("Manual");
        setShowAddForm(false);
        await loadLibrary();
      } else {
        setNotice(res?.error || "Failed to add game.");
      }
    } catch (err) {
      console.error("Save game failed:", err);
      setNotice("Failed to add game.");
    } finally {
      setSaving(false);
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

      {notice && (
        <div className={styles.notice}>
          <span>{notice}</span>
          <button className={styles.noticeClose} onClick={() => setNotice("")}>
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

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
            {installed.length === 0 && !showAddForm ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>
                  <Gamepad2 className="w-12 h-12 stroke-[1.5]" />
                </div>
                <h3>No installed games detected</h3>
                <p>Add a game executable to your library to launch it straight from the app.</p>
                <div className={styles.dirPath}>{downloadDir}</div>
                <div className={styles.emptyActions}>
                  <button className={styles.openBtn} onClick={() => openFolder()}>
                    <FolderOpen className="w-4 h-4" />
                    Open Downloads Folder
                  </button>
                  <button className={styles.addBtn} onClick={() => setShowAddForm(true)}>
                    <Plus className="w-4 h-4" />
                    Add Game
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className={styles.listHeader}>
                  <div className={styles.listHeaderActions}>
                    <button className={styles.openBtn} style={{ marginTop: 0 }} onClick={() => openFolder()}>
                      <FolderOpen className="w-4 h-4" />
                      Open Downloads Folder
                    </button>
                    <button className={styles.addBtn} style={{ marginTop: 0 }} onClick={() => setShowAddForm((v) => !v)}>
                      {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                      {showAddForm ? "Close" : "Add Game"}
                    </button>
                  </div>
                </div>

                {showAddForm && (
                  <form className={styles.addForm} onSubmit={saveManualGame}>
                    <div className={styles.addFormTitle}>Add a game to your library</div>
                    <div className={styles.addFormGrid}>
                      <label className={styles.addField}>
                        <span>Game Name *</span>
                        <input
                          type="text"
                          value={addName}
                          onChange={(e) => setAddName(e.target.value)}
                          placeholder="e.g. Cyberpunk 2077"
                        />
                      </label>
                      <label className={styles.addField}>
                        <span>Executable Path *</span>
                        <div className={styles.pathInputWrap}>
                          <input
                            type="text"
                            value={addPath}
                            onChange={(e) => setAddPath(e.target.value)}
                            placeholder="C:\Games\Cyberpunk 2077\bin\x64\Cyberpunk2077.exe"
                          />
                          <button
                            type="button"
                            className={styles.browseBtn}
                            onClick={pickExecutable}
                            title="Browse for executable"
                          >
                            <FolderSearch className="w-4 h-4" />
                            Browse
                          </button>
                        </div>
                      </label>
                      <label className={styles.addField}>
                        <span>Size (optional)</span>
                        <input
                          type="text"
                          value={addSize}
                          onChange={(e) => setAddSize(e.target.value)}
                          placeholder="e.g. 45.2 GB"
                        />
                      </label>
                      <label className={styles.addField}>
                        <span>Year (optional)</span>
                        <input
                          type="text"
                          value={addYear}
                          onChange={(e) => setAddYear(e.target.value)}
                          placeholder="e.g. 2020"
                        />
                      </label>
                      <label className={styles.addField}>
                        <span>Source (optional)</span>
                        <input
                          type="text"
                          value={addSource}
                          onChange={(e) => setAddSource(e.target.value)}
                          placeholder="e.g. Steam, Epic, Manual"
                        />
                      </label>
                    </div>
                    <div className={styles.addFormActions}>
                      <button type="button" className={styles.cancelBtn} onClick={() => setShowAddForm(false)}>
                        Cancel
                      </button>
                      <button type="submit" className={styles.saveBtn} disabled={saving}>
                        {saving ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" /> Adding…
                          </>
                        ) : (
                          <>
                            <Plus className="w-4 h-4" /> Add to Library
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                )}

                <div className={styles.list}>
                  {installed.map((game) => (
                    <div key={game.id} className={styles.listItem}>
                      <div className={styles.listIconWrapper}>
                        <Gamepad2 className="w-5 h-5" />
                      </div>
                      <div className={styles.listInfo}>
                        <h4>{game.name}</h4>
                        <p>{game.executablePath}</p>
                        <div className={styles.listMetaRow}>
                          {game.source && (
                            <span className={styles.listSource}>{game.source}</span>
                          )}
                          {game.year && (
                            <span className={styles.listYear}>
                              {formatYearDisplay(game.year)}
                            </span>
                          )}
                          {game.size && (
                            <span className={styles.listSize}>
                              {formatBytes(game.size)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className={styles.listActions}>
                        <button
                          className={styles.openBtn}
                          style={{ marginTop: 0 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openFolder(game.executablePath);
                          }}
                          title="Show in folder"
                        >
                          <Folder className="w-3.5 h-3.5" />
                        </button>
                        <button
                          className={styles.launchBtn}
                          disabled={launchingId === game.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            launchGame(game);
                          }}
                        >
                          {launchingId === game.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5 fill-current" />
                          )}
                          Launch
                        </button>
                        <button
                          className={styles.removeBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeGame(game);
                          }}
                          title="Remove from library"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
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
                        {item.source || "Direct"} • {formatBytes(item.totalBytes)}
                      </p>
                    </div>
                    <div className={styles.listActions}>
                      {item.status === "error" && (
                        <button
                          className={styles.retryBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            invoke("continue-download", item.id);
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

            {folderLoading ? (
              <p className={styles.folderLoading}>Loading contents…</p>
            ) : folderEntries.length === 0 ? (
              <p className={styles.folderEmpty}>This folder is empty.</p>
            ) : (
              <div className={styles.folderList}>
                {folderEntries.map((entry) => (
                  <div key={entry.path} className={styles.folderItem}>
                    <div className={styles.folderItemIcon}>
                      {entry.isDirectory ? (
                        <Folder className="w-4 h-4 text-amber-400" />
                      ) : (
                        <DownloadCloud className="w-4 h-4 text-sky-400" />
                      )}
                    </div>
                    <div className={styles.folderItemInfo}>
                      <span className={styles.folderItemName} title={entry.name}>
                        {entry.name}
                      </span>
                      <span className={styles.folderItemMeta}>
                        {entry.isDirectory ? "Folder" : formatBytes(entry.size)}
                        {entry.modifiedAt
                          ? ` • ${new Date(entry.modifiedAt).toLocaleDateString()}`
                          : ""}
                      </span>
                    </div>
                    <div className={styles.folderItemActions}>
                      <button
                        className={styles.openBtn}
                        style={{ marginTop: 0 }}
                        onClick={() => openFolder(entry.path)}
                        title="Show in folder"
                      >
                        <FolderSearch className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className={styles.removeBtn}
                        onClick={() => deleteEntry(entry)}
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
