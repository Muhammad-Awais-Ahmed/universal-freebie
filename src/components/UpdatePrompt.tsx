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

    // The main process only emits this when the published release is not
    // newer than the running build, or when the user already skipped it.
    // Either way any dialog left over from an earlier check must go away.
    const onNotAvailable = () => {
      setUpdate(null);
      setState(null);
      setProgress(0);
    };

    ipcRenderer.on("update-available", onAvailable);
    ipcRenderer.on("update-download-progress", onProgress);
    ipcRenderer.on("update-downloaded", onDownloaded);
    ipcRenderer.on("update-error", onError);
    ipcRenderer.on("update-not-available", onNotAvailable);

    return () => {
      ipcRenderer.removeListener("update-available", onAvailable);
      ipcRenderer.removeListener("update-download-progress", onProgress);
      ipcRenderer.removeListener("update-downloaded", onDownloaded);
      ipcRenderer.removeListener("update-error", onError);
      ipcRenderer.removeListener("update-not-available", onNotAvailable);
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

  const checkForUpdates = async () => {
    setError("");
    setState("available");
    const { ipcRenderer } = window.require("electron");
    await ipcRenderer.invoke("update:check-latest");
  };

  // "Later" is remembered for this specific version, so the dialog does not
  // reappear on the next launch. A genuinely newer release still shows up.
  const dismiss = async () => {
    const version = update?.version;
    setUpdate(null);
    setState(null);
    setProgress(0);
    const { ipcRenderer } = window.require("electron");
    await ipcRenderer.invoke("update:skip", version);
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
          {state !== "downloading" && (
            <button className="update-button update-button-muted" onClick={checkForUpdates}>Check for updates</button>
          )}
          {state !== "downloading" && <button className="update-button update-button-muted" onClick={dismiss}>Later</button>}
        </div>
      </div>
    </div>
  );
}
