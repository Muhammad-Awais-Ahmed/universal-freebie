"use client";

import { useState } from "react";
import styles from "./LinkDownload.module.css";

export default function LinkDownload() {
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const handleDownload = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setMessage({ type: "err", text: "Paste a download link first." });
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const { ipcRenderer } = (window as any).require("electron");
      const res = await ipcRenderer.invoke(
        "download-link",
        trimmed,
        filename.trim() ? { filename: filename.trim() } : {}
      );

      if (res && res.error) {
        setMessage({ type: "err", text: res.error });
      } else {
        setMessage({
          type: "ok",
          text: `Started download: ${res?.filename || "file"}`,
        });
        setUrl("");
        setFilename("");
      }
    } catch (err: any) {
      console.error("Link download failed:", err);
      setMessage({ type: "err", text: err?.message || "Download failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.icon}>🔗</span>
        <div>
          <h3 className={styles.title}>Download by Link</h3>
          <p className={styles.subtitle}>
            Paste a direct file URL to download it through the app.
          </p>
        </div>
      </div>

      <div className={styles.row}>
        <input
          type="text"
          className={styles.input}
          placeholder="https://example.com/file.zip"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) handleDownload();
          }}
        />
      </div>

      <div className={styles.row}>
        <input
          type="text"
          className={styles.input}
          placeholder="Save as (optional, e.g. game.zip)"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) handleDownload();
          }}
        />
        <button
          className={styles.btn}
          onClick={handleDownload}
          disabled={busy || !url.trim()}
        >
          {busy ? "Starting..." : "Download"}
        </button>
      </div>

      {message && (
        <p
          className={`${styles.msg} ${
            message.type === "ok" ? styles.msgOk : styles.msgErr
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
