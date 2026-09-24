"use client";

import { useEffect, useState } from "react";

interface UpdateInfo {
  version: string;
  currentVersion: string;
}

type UpdateState = "available" | "downloading" | "ready" | "error" | null;

export default function UpdatePrompt() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<UpdateState>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof window.require !== "function") return;

    const { ipcRenderer } = window.require("electron");
    const onAvailable = (_event: unknown, info: UpdateInfo) => {
      setUpdate(info);
      setState("available");
    };
    const onProgress = (_event: unknown, info: { percent: number }) => {
      setProgress(info.percent);
      setState("downloading");
    };
    const onDownloaded = (_event: unknown, info: UpdateInfo) => {
      setUpdate((current) => current || info);
      setProgress(100);
      setState("ready");
    };
    const onError = (_event: unknown, info: { message?: string }) => {
      setError(info.message || "The update could not be downloaded.");
      setState("error");
    };

    ipcRenderer.on("update-available", onAvailable);
    ipcRenderer.on("update-download-progress", onProgress);
    ipcRenderer.on("update-downloaded", onDownloaded);
    ipcRenderer.on("update-error", onError);

    return () => {
      ipcRenderer.removeListener("update-available", onAvailable);
      ipcRenderer.removeListener("update-download-progress", onProgress);
      ipcRenderer.removeListener("update-downloaded", onDownloaded);
      ipcRenderer.removeListener("update-error", onError);
    };
  }, []);

  if (!update || !state) return null;

  const startDownload = async () => {
    setError("");
    setState("downloading");
    const { ipcRenderer } = window.require("electron");
    await ipcRenderer.invoke("update:start-download");
  };

  const installUpdate = () => {
    window.require("electron").ipcRenderer.invoke("update:install");
  };

  return (
    <div className="update-overlay" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="update-card">
        <div className="update-kicker">SYSTEM UPDATE</div>
        <h2 id="update-title">Universal Freebie {update.version} is ready</h2>
        <p>
          A newer version is available. Download it now to receive the latest fixes and improvements.
          Your library and settings will be kept.
        </p>

        {state === "downloading" && (
          <div className="update-progress" aria-live="polite">
            <div className="update-progress-label">Downloading update... {progress}%</div>
            <div className="update-progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        {state === "error" && <p className="update-error">{error}</p>}

        <div className="update-actions">
          {state === "ready" ? (
            <button className="update-button update-button-primary" onClick={installUpdate}>Restart and install</button>
          ) : state === "downloading" ? (
            <button className="update-button update-button-muted" disabled>Downloading...</button>
          ) : (
            <button className="update-button update-button-primary" onClick={startDownload}>Download update</button>
          )}
          {state !== "downloading" && <button className="update-button update-button-muted" onClick={() => setState(null)}>Later</button>}
        </div>
      </div>
    </div>
  );
}
