"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";

export default function SettingsPage() {
  const [downloadDir, setDownloadDir] = useState("...");
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [maxChunks, setMaxChunks] = useState(32);
  const [webtorrentTrackers, setWebtorrentTrackers] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const settings = await ipcRenderer.invoke("get-settings");
      if (settings) {
        setDownloadDir(settings.downloadDirectory || "...");
        setMaxConcurrent(settings.maxConcurrent || 3);
        setMaxChunks(settings.maxChunks || 32);
        setWebtorrentTrackers(settings.webtorrentTrackers || "");
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
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
      });
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
              max="10"
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
              max="64"
              step="8"
              value={maxChunks}
              onChange={(e) => setMaxChunks(parseInt(e.target.value))}
              className={styles.slider}
            />
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
