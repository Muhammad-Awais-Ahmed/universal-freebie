/**
 * Universal Freebie — automatic post-download installation
 *
 * Runs as a side-effect of a download completing:
 *   1. Ask the AI backend which file in the download is the real installer.
 *   2. Install every prerequisite runtime the machine is actually missing
 *      (Visual C++ / DirectX / .NET), silently and in the correct order.
 *   3. Launch the game's installer.
 *   4. Once that installer exits, delete the archive, the extracted staging
 *      tree and any sidecar files — the installed game is untouched.
 *
 * Everything here is opt-in via Settings and is safe to call concurrently:
 * one download never blocks another, and a failure is reported, never thrown.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const {
  planInstall,
  runInstaller,
  installMissingDependencies,
  cleanupDownloadArtifacts,
  pruneEmptyStaging,
  findGameExecutable,
  isLikelyGameExecutable,
  INSTALLED_DIR_NAME,
} = require('./aiInstaller');

// How long to wait for the game's own installer before giving up and keeping
// the downloaded files. Installers that spawn a child and exit immediately
// (very common) are handled by the "process tree is gone" check.
const INSTALLER_EXIT_GRACE_MS = 5 * 60 * 1000;
const MIN_WATCH_MS = 20 * 1000;
const POLL_INTERVAL_MS = 3000;

function safeName(value) {
  return String(value || 'game')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 80) || 'game';
}

class AutoInstaller extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.active = new Map();
    this.state = new Map();
    // Set by the main process. Receives { name, executablePath, size, source }
    // once a game is installed on disk, and must return the stored library
    // entry (or null). Failures are swallowed on purpose: registering the game
    // is a convenience, never a reason to fail an install.
    this.onRegisterGame = null;
  }

  isEnabled() {
    const settings = this.getSettings() || {};
    return settings.autoInstallEnabled === true;
  }

  _publish(downloadId, patch) {
    const next = Object.assign({}, this.state.get(downloadId) || {}, patch, {
      downloadId,
      updatedAt: Date.now(),
    });
    this.state.set(downloadId, next);
    this.emit('progress', next);
    return next;
  }

  getState(downloadId) {
    return this.state.get(downloadId) || null;
  }

  getAllStates() {
    return Array.from(this.state.values());
  }

  clearState(downloadId) {
    this.state.delete(downloadId);
  }

  /**
   * Entry point wired to Downloader.onCompleted.
   * `options.force` bypasses the settings toggle (manual "Install" button).
   */
  async handleCompleted(item, options = {}) {
    if (!item || !item.id) return;
    // The stale snapshot is captured on purpose: by the time the async work
    // finishes the item may have been evicted from the live map.
    const snapshot = {
      id: item.id,
      filename: item.filename,
      filePath: item.filePath,
      source: (item.meta && item.meta.source) || 'Unknown',
    };

    const settings = this.getSettings() || {};
    if (settings.autoInstallEnabled !== true && options.force !== true) return;
    if (this.active.has(snapshot.id)) return;

    const task = this._run(snapshot, settings)
      .catch((error) => {
        this._publish(snapshot.id, {
          phase: 'error',
          error: error.message || 'Automatic installation failed.',
        });
      })
      .finally(() => {
        this.active.delete(snapshot.id);
      });

    this.active.set(snapshot.id, task);
    return task;
  }

  async _run(item, settings) {
    const downloadDirectory = this.getSettings().downloadDirectory;
    const filePath = item.filePath || path.join(downloadDirectory, item.filename || '');

    this._publish(item.id, {
      phase: 'planning',
      filename: item.filename,
      message: 'Asking the AI which file is the installer…',
    });

    if (!fs.existsSync(filePath)) {
      this._publish(item.id, {
        phase: 'error',
        error: 'The downloaded file is no longer available.',
      });
      return;
    }

    // ---- 1. AI picks the installer -------------------------------------
    const plan = await planInstall({
      filePath,
      gameTitle: item.filename,
      source: item.source
    });

    if (!plan || plan.error) {
      this._publish(item.id, {
        phase: 'skipped',
        error: (plan && plan.error) || 'No installer could be identified.',
        message: 'Download kept.',
      });
      return;
    }

    // The staging tree is where the archive was expanded, when applicable.
    const stagingDirectory = plan.stagingDirectory || null;

    this._publish(item.id, {
      phase: 'installer-found',
      message: plan.displayPath || path.basename(plan.installerPath),
      confidence: plan.confidence,
    });

    // ---- 2. Prerequisites ----------------------------------------------
    if (settings.autoInstallDependencies !== false) {
      this._publish(item.id, {
        phase: 'dependencies',
        message: 'Checking required runtimes…',
      });

      const bundled = plan.stagingDirectory
        ? listExecutables(plan.stagingDirectory)
        : [plan.installerPath];

      const dependencies = await installMissingDependencies(bundled, {
        onUpdate: (update) => {
          this._publish(item.id, {
            phase: update.phase,
            message: dependencyMessage(update),
            dependencyLabel: update.label,
            dependencyFraction: typeof update.fraction === 'number' ? update.fraction : undefined,
          });
        },
      });

      this._publish(item.id, {
        phase: 'dependencies-done',
        dependenciesInstalled: dependencies.installed.map((entry) => entry.label),
        dependenciesFailed: dependencies.failed.map((entry) => entry.label),
        message: dependencies.installed.length
          ? `Installed ${dependencies.installed.length} prerequisite(s).`
          : 'No missing prerequisites.',
      });
    }

    // ---- 3. Launch the game installer ----------------------------------
    if (settings.autoLaunchInstaller === false) {
      this._publish(item.id, {
        phase: 'awaiting-manual-install',
        message: 'Download kept — start the installer yourself.',
      });
      return;
    }

    this._publish(item.id, {
      phase: 'installing',
      message: 'Running the game installer…',
    });

    const launched = runInstaller(plan.installerPath, downloadDirectory);
    if (!launched.ok) {
      this._publish(item.id, {
        phase: 'error',
        error: launched.error || 'The installer could not be started.',
        message: 'Download kept.',
      });
      return;
    }

    // ---- 4. Wait for it, then clean up ---------------------------------
    if (settings.autoDeleteAfterInstall === true) {
      const finished = await this._waitForInstaller(plan.installerPath, item.id);
      if (finished) {
        // Register the game BEFORE the staging tree is deleted: for in-place /
        // "portable" repacks the runnable binary is the thing being removed.
        const library = this._registerInLibrary({
          item,
          plan,
          stagingDirectory,
          downloadDirectory,
        });

        const cleanup = cleanupDownloadArtifacts({
          filePath,
          stagingDirectory,
          downloadDirectory,
        });
        pruneEmptyStaging(downloadDirectory);

        this._publish(item.id, {
          phase: 'cleaned',
          message: library
            ? `Installation finished. Added "${library.name}" to your library.`
            : `Installation finished. Removed ${cleanup.removed.length} downloaded file(s).`,
          removed: cleanup.removed,
          cleanupSkipped: cleanup.skipped,
          library,
        });
        return;
      }

      this._publish(item.id, {
        phase: 'cleanup-skipped',
        message: 'The installer is still running, so the downloaded files were kept.',
      });
      return;
    }

    // ---- 5. Register the game in the library ---------------------------
    // Only safe to scan here: the installer has just been handed the user's
    // files but may still be writing, and a half-extracted tree would yield a
    // bogus executable. When the download is kept, the user decides when the
    // game is ready via the "Add to Library" button.
    this._publish(item.id, {
      phase: 'installed',
      message: 'Installer started. Downloaded files were kept.',
    });
  }

  /**
   * Finds the installed game executable and hands it to the library.
   *
   * Deliberately synchronous and best-effort: a failure here must never turn a
   * successful install into an error, it just means the game is not
   * pre-registered and the user can add it by hand.
   */
  _registerInLibrary({ item, plan, stagingDirectory, downloadDirectory }) {
    if (typeof this.onRegisterGame !== 'function') return null;

    const installerPath = (plan && plan.installerPath) || null;
    const roots = [
      stagingDirectory,
      item.filePath,
      path.join(downloadDirectory, INSTALLED_DIR_NAME),
    ].filter(Boolean);

    for (const root of roots) {
      let found = null;
      try {
        found = findGameExecutable(root, { installerPath });
      } catch (e) {
        found = null;
      }
      if (!found) continue;

      const name = path.basename(found.absolutePath, path.extname(found.absolutePath));
      // A download folder is named after the release, which reads far better
      // in the library than "Game-Win64-Shipping".
      const game = {
        name: safeName(item.filename.replace(/\.[^.]+$/, '')) || name,
        executablePath: found.absolutePath,
        size: typeof found.size === 'number' ? String(found.size) : null,
        source: item.source || 'Installed',
      };
      try {
        return this.onRegisterGame(game) || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * Resolves true once the installer is no longer running.
   *
   * `runInstaller` detaches the child, so instead of tracking a PID we watch
   * whether any process still holds the installer executable open. That also
   * correctly handles installers that relaunch themselves elevated.
   */
  _waitForInstaller(installerPath, downloadId) {
    return new Promise((resolve) => {
      const startedAt = Date.now();

      const finish = (value) => {
        clearInterval(timer);
        resolve(value);
      };

      const timer = setInterval(async () => {
        const elapsed = Date.now() - startedAt;

        if (elapsed > INSTALLER_EXIT_GRACE_MS) {
          finish(false);
          return;
        }

        let running = true;
        try {
          // Only trust the probe after the minimum window; a fast installer
          // would otherwise look "already gone" before it even started.
          if (elapsed < MIN_WATCH_MS) {
            running = true;
          } else {
            running = await isProcessRunning(installerPath);
          }
        } catch (e) {
          running = true; // on doubt, keep the files
        }

        if (!running) {
          finish(true);
          return;
        }

        this._publish(downloadId, {
          phase: 'installing',
          message: 'Waiting for the installer to finish…',
        });
      }, POLL_INTERVAL_MS);
    });
  }
}

function listExecutables(root) {
  const found = [];
  const visit = (directory, depth) => {
    if (depth > 4 || found.length > 400) return;
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
      } else if (['.exe', '.msi'].includes(path.extname(entry.name).toLowerCase())) {
        found.push(absolute);
      }
    }
  };
  visit(root, 0);
  return found;
}

function dependencyMessage(update) {
  switch (update.phase) {
    case 'dependency':
      return `Installing ${update.label} (${update.index + 1}/${update.total})…`;
    case 'dependency-download':
      return `Downloading ${update.label}…`;
    case 'dependency-installing':
      return `Setting up ${update.label}…`;
    case 'dependency-failed':
      return `Could not install ${update.label}.`;
    default:
      return update.label || 'Working…';
  }
}

/**
 * True when a process is still running the given executable.
 * Compares only the file name so we do not need elevated rights to query.
 */
function isProcessRunning(exePath) {
  const { execFile } = require('child_process');
  const target = path.basename(exePath).toLowerCase();

  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/fo', 'csv', '/nh'], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        // If we cannot tell, assume it is still running so files are kept.
        resolve(true);
        return;
      }
      const running = String(stdout)
        .split(/\r?\n/)
        .some((line) => line.toLowerCase().includes(`"${target}"`));
      resolve(running);
    });
  });
}

module.exports = { AutoInstaller };
