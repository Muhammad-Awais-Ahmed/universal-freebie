/**
 * Universal Freebie — automatic post-download installation
 *
 * Runs as a side-effect of a download completing:
 *   1. Ask the AI backend which file in the download is the real installer.
 *   2. Install missing prerequisite runtimes that shipped with the download.
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
  INSTALLED_DIR_NAME,
} = require('./aiInstaller');


function safeName(value) {
  return String(value || 'game')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 80) || 'game';
}

class AutoInstaller extends EventEmitter {
  constructor(getSettings, persistStates = null) {
    super();
    this.getSettings = getSettings;
    this.persistStates = typeof persistStates === 'function' ? persistStates : null;
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
    if (this.persistStates) {
      try { this.persistStates(this.getAllStates()); } catch (e) {}
    }
    this.emit('progress', next);
    return next;
  }

  restoreStates(savedStates) {
    if (!savedStates) return;
    const entries = Array.isArray(savedStates)
      ? savedStates
      : Object.values(savedStates);
    for (const state of entries) {
      if (!state || !state.downloadId) continue;
      const activePhases = new Set([
        'planning', 'installer-found', 'dependencies', 'dependency',
        'dependency-download', 'dependency-installing', 'dependencies-done', 'installing'
      ]);
      const restored = activePhases.has(state.phase)
        ? Object.assign({}, state, {
            phase: 'interrupted',
            message: 'Install state could not resume after app restart. Review or run it again.',
            error: 'The app restarted before setup completed.',
          })
        : Object.assign({}, state);
      this.state.set(state.downloadId, restored);
    }
    if (this.persistStates) {
      try { this.persistStates(this.getAllStates()); } catch (e) {}
    }
  }

  getState(downloadId) {
    return this.state.get(downloadId) || null;
  }

  getAllStates() {
    return Array.from(this.state.values());
  }

  clearState(downloadId) {
    this.state.delete(downloadId);
    if (this.persistStates) {
      try { this.persistStates(this.getAllStates()); } catch (e) {}
    }
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

      const failedLabels = (dependencies.failed || []).map((entry) => entry.label);
      this._publish(item.id, {
        phase: 'dependencies-done',
        dependenciesInstalled: (dependencies.installed || []).map((entry) => entry.label),
        dependenciesFailed: failedLabels,
        message: (dependencies.installed || []).length
          ? `Installed ${(dependencies.installed || []).length} bundled prerequisite(s).`
          : 'No bundled prerequisites needed installation.',
      });

      if (failedLabels.length || dependencies.ok === false) {
        this._publish(item.id, {
          phase: 'prerequisite-failed',
          dependenciesInstalled: (dependencies.installed || []).map((entry) => entry.label),
          dependenciesFailed: failedLabels,
          error: dependencies.error || 'One or more prerequisite installers failed.',
          message: 'Prerequisite failure stopped the game installer. The downloaded archive was kept.',
        });
        return;
      }
    }

    // ---- 3. Launch the game installer ----------------------------------
    if (settings.autoLaunchInstaller === false) {
      this._publish(item.id, {
        phase: 'awaiting-manual-install',
        message: 'Installer is ready — start it yourself to finish the setup.',
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

    const outcome = await this._waitForInstaller(launched);
    const finished = typeof outcome === 'boolean'
      ? outcome
      : outcome && outcome.ok === true;

    if (!finished) {
      const exitCode = typeof outcome === 'object' ? outcome.exitCode : null;
      const signal = typeof outcome === 'object' ? outcome.signal : null;
      const cancelled = signal || exitCode === 1223 || exitCode === 1602 || exitCode === 1604;
      this._publish(item.id, {
        phase: cancelled ? 'installer-cancelled' : 'error',
        error: cancelled
          ? 'The installer was cancelled. The downloaded files were kept.'
          : (typeof outcome === 'object' && outcome.error) || 'The game installer failed.',
        exitCode,
        signal,
        message: cancelled
          ? 'Retry installation to continue.'
          : 'The installer did not finish successfully. Download kept — retry installation.',
      });
      return;
    }

    if (settings.autoDeleteAfterInstall === true) {
      // Only remove the source after finding the game in the app-managed
      // Installed folder. Setup programs often install elsewhere, and an
      // executable found in staging may itself be the portable game.
      const library = this._registerInLibrary({
        item,
        plan,
        stagingDirectory: null,
        downloadDirectory,
        requireGameFolder: true,
      });
      if (!library) {
        this._publish(item.id, {
          phase: 'installed',
          message: 'Installation finished, but the game location could not be verified. Downloaded files were kept.',
        });
        return;
      }

      const cleanup = cleanupDownloadArtifacts({
        filePath,
        stagingDirectory,
        downloadDirectory,
      });
      pruneEmptyStaging(downloadDirectory);

      this._publish(item.id, {
        phase: 'cleaned',
        message: `Installation finished. Added "${library.name}" to your library.`,
        removed: cleanup.removed,
        cleanupSkipped: cleanup.skipped,
        library,
      });
      return;
    }

    // Register the game once the installer is actually finished, even when the
    // download is preserved in-place. This keeps the post-install flow real-time
    // and makes the library update happen without any extra user click.
    const library = this._registerInLibrary({
      item,
      plan,
      stagingDirectory,
      downloadDirectory,
    });

    this._publish(item.id, {
      phase: 'installed',
      message: library
        ? `Installation finished. Added "${library.name}" to your library.`
        : 'Installation finished. The game is ready — add it to the library from the Library page if needed.',
      library,
    });
  }

  /**
   * Finds the installed game executable and hands it to the library.
   *
   * Deliberately synchronous and best-effort: a failure here must never turn a
   * successful install into an error, it just means the game is not
   * pre-registered and the user can add it by hand.
   */
  _registerInLibrary({ item, plan, stagingDirectory, downloadDirectory, requireGameFolder = false }) {
    if (typeof this.onRegisterGame !== 'function') return null;

    const installerPath = (plan && plan.installerPath) || null;
    const installedRoot = path.join(downloadDirectory, INSTALLED_DIR_NAME);
    const installedGameRoot = requireGameFolder
      ? path.join(installedRoot, safeName(String(item.filename || 'game').replace(/\.[^.]+$/, '')))
      : installedRoot;
    const roots = [
      stagingDirectory,
      item.filePath,
      installedGameRoot,
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

  /** Await the exact child process launched for this setup. */
  async _waitForInstaller(launched) {
    if (launched && typeof launched === 'object' && launched.result) {
      return launched.result;
    }

    // Backward-compatible test seam: true means an installer finished
    // successfully; false/undefined means it did not.
    if (typeof launched === 'boolean') {
      return { ok: launched, exitCode: launched ? 0 : null, signal: null };
    }
    return { ok: true, exitCode: 0, signal: null };
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

module.exports = { AutoInstaller };
