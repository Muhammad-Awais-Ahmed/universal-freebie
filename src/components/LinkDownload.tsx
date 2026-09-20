"use client";

import { useState } from "react";
import styles from "./LinkDownload.module.css";
import { Link2, Video, Zap, Info, CheckCircle2, AlertCircle, DownloadCloud, Loader2 } from "lucide-react";

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
        <div className={styles.iconWrapper}>
          {isMediaUrl ? <Video className="w-5 h-5 text-purple-400" /> : <Link2 className="w-5 h-5 text-purple-400" />}
        </div>
        <div>
          <h3 className={styles.title}>Direct Link &amp; Stream Downloader</h3>
          <p className={styles.subtitle}>
            Paste any direct game zip URL or video link to accelerate download through the client.
          </p>
        </div>
      </div>

      <div className={styles.row}>
        <input
          type="text"
          className={styles.input}
          placeholder="https://example.com/game.zip or https://youtube.com/watch?v=..."
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
              <Zap className="w-4 h-4 text-cyan-400" />
              <span>{isYouTube ? "YouTube Stream Detected" : "Media Stream Detected"} — Target Quality</span>
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
            <Info className="w-3.5 h-3.5 text-cyan-400" />
            <span>{currentHint}</span>
          </div>
        </div>
      )}

      <div className={styles.row}>
        <input
          type="text"
          className={styles.input}
          placeholder="Save as custom filename (optional, e.g. cyberpunk_patch.zip)"
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
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Starting…
            </>
          ) : (
            <>
              <DownloadCloud className="w-4 h-4" />
              {isMediaUrl
                ? quality === "audio"
                  ? "Grab Audio"
                  : `Download ${quality}p`
                : "Start Download"}
            </>
          )}
        </button>
      </div>

      {message && (
        <div
          className={`${styles.msg} ${
            message.type === "ok" ? styles.msgOk : styles.msgErr
          }`}
        >
          {message.type === "ok" ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
}
