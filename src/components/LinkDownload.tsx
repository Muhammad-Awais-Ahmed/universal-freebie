"use client";

import { useState } from "react";
import styles from "./LinkDownload.module.css";

const QUALITY_OPTIONS = [
  { value: "1080", label: "1080p Full HD (Recommended)", hint: "Crisp Full HD with great audio. Best quality-to-size balance." },
  { value: "2160", label: "4K Ultra HD (2160p)", hint: "Ultra crisp 4K resolution. Merges video and audio." },
  { value: "1440", label: "2K Quad HD (1440p)", hint: "2K QHD resolution with crystal clear detail." },
  { value: "720", label: "720p HD", hint: "Standard high definition, faster download speed." },
  { value: "480", label: "480p Standard (SD)", hint: "Standard definition, compact file size." },
  { value: "360", label: "360p Data Saver", hint: "Smallest video file size, lower resolution." },
  { value: "best", label: "Best Available (Max Quality)", hint: "Downloads the highest resolution available (up to 4K / 8K)." },
  { value: "audio", label: "Audio Only (MP3)", hint: "Extracts and converts stream to high quality MP3." },
];

const QUICK_PILLS = [
  { value: "1080", label: "1080p FHD", badge: "★ Best" },
  { value: "720", label: "720p HD", badge: "Fast" },
  { value: "2160", label: "4K UHD", badge: "4K" },
  { value: "best", label: "Max Quality", badge: "Auto" },
  { value: "audio", label: "Audio Only", badge: "MP3" },
];

export default function LinkDownload() {
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [quality, setQuality] = useState("1080");
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

    const isMedia = /(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitch\.tv|dailymotion\.com)/i.test(trimmed);

    try {
      const { ipcRenderer } = (window as any).require("electron");
      const res = await ipcRenderer.invoke(
        "download-link",
        trimmed,
        {
          filename: filename.trim() || undefined,
          quality: isMedia ? quality : undefined,
        }
      );

      if (res && res.error) {
        setMessage({ type: "err", text: res.error });
      } else {
        const qualityLabel = isMedia
          ? (quality === "audio" ? "MP3" : (quality === "best" ? "Max Quality" : `${quality}p`))
          : null;
        setMessage({
          type: "ok",
          text: `Started download: ${res?.filename || "file"}${qualityLabel ? ` [${qualityLabel}]` : ""}`,
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

  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(url.trim());
  const isMediaUrl = /(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitch\.tv|dailymotion\.com)/i.test(url.trim());
  const currentHint = QUALITY_OPTIONS.find((q) => q.value === quality)?.hint || "High quality video and audio merged via FFmpeg.";

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.icon}>{isMediaUrl ? "🎬" : "🔗"}</span>
        <div>
          <h3 className={styles.title}>Download by Link</h3>
          <p className={styles.subtitle}>
            Paste any direct file URL or YouTube link to download it through the app.
          </p>
        </div>
      </div>

      <div className={styles.row}>
        <input
          type="text"
          className={styles.input}
          placeholder="https://example.com/file.zip or https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) handleDownload();
          }}
        />
      </div>

      {isMediaUrl && (
        <div className={styles.qualityBox}>
          <div className={styles.qualityTopRow}>
            <span className={styles.qualityLabel}>
              <span>⚡</span>
              <span>{isYouTube ? "YouTube Video Detected" : "Media Video Detected"} — Choose Quality</span>
            </span>
          </div>

          <div className={styles.qualityPills}>
            {QUICK_PILLS.map((pill) => (
              <button
                key={pill.value}
                type="button"
                className={`${styles.qualityPill} ${quality === pill.value ? styles.qualityPillActive : ""}`}
                onClick={() => setQuality(pill.value)}
              >
                <span>{pill.label}</span>
                <span className={styles.pillBadge}>{pill.badge}</span>
              </button>
            ))}
          </div>

          <div className={styles.qualityDropdownRow}>
            <select
              className={styles.qualitySelect}
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              {QUALITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.qualityHint}>
            <span>ℹ️</span>
            <span>{currentHint}</span>
          </div>
        </div>
      )}

      <div className={styles.row}>
        <input
          type="text"
          className={styles.input}
          placeholder="Save as (optional, e.g. video.mp4 or game.zip)"
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
          {busy
            ? "Starting..."
            : isMediaUrl
            ? quality === "audio"
              ? "Download MP3 Audio"
              : quality === "best"
              ? "Download Max Quality"
              : `Download ${quality}p Video`
            : "Download"}
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
