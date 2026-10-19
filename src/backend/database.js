const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app } = require('electron');

class Database {
  constructor() {
    this.dbPath = path.join(app.getPath('userData'), 'UniversalGameClient_DB.json');
    this.data = this._loadData();
  }

  _loadData() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('Failed to load database:', err);
    }
    
    return {
      settings: {
        downloadDirectory: path.join(app.getPath('downloads'), 'UniversalGameClient'),
        // Automatic installation is opt-in: nothing runs without consent.
        autoInstallEnabled: false,
        autoInstallDependencies: true,
        autoLaunchInstaller: true,
        autoDeleteAfterInstall: false
      },
      downloadHistory: [],
      installedGames: []
    };
  }

  _saveData() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save database:', err);
    }
  }

  getSettings() {
    return this.data.settings;
  }

  updateSettings(newSettings) {
    this.data.settings = { ...this.data.settings, ...newSettings };
    this._saveData();
    return this.data.settings;
  }

  getDownloadHistory() {
    return this.data.downloadHistory;
  }

  addDownloadToHistory(downloadItem) {
    const exists = this.data.downloadHistory.find(d => d.id === downloadItem.id);
    const meta = downloadItem.meta ? {
      source: downloadItem.meta.source,
      title: downloadItem.meta.title,
      quality: downloadItem.meta.quality,
      description: downloadItem.meta.description,
    } : undefined;
    if (exists) {
      // Update existing entry (e.g. resume → completed)
      Object.assign(exists, {
        filename: downloadItem.filename,
        url: downloadItem.url,
        type: downloadItem.type || exists.type || 'http',
        totalBytes: downloadItem.totalBytes,
        downloadedBytes: downloadItem.downloadedBytes,
        source: downloadItem.meta?.source || exists.source,
        meta: meta || exists.meta,
        chunkSize: downloadItem.chunkSize || exists.chunkSize || null,
        completedRanges: Array.isArray(downloadItem.completedRanges)
          ? downloadItem.completedRanges
          : exists.completedRanges || [],
        status: downloadItem.status || 'completed',
        dateCompleted: downloadItem.status === 'completed' ? new Date().toISOString() : exists.dateCompleted
      });
      this._saveData();
    } else {
      this.data.downloadHistory.unshift({
        id: downloadItem.id,
        filename: downloadItem.filename,
        url: downloadItem.url,
        type: downloadItem.type || 'http',
        totalBytes: downloadItem.totalBytes,
        downloadedBytes: downloadItem.downloadedBytes || 0,
        source: downloadItem.meta?.source || 'Unknown',
        meta: meta || {},
        chunkSize: downloadItem.chunkSize || null,
        completedRanges: Array.isArray(downloadItem.completedRanges) ? downloadItem.completedRanges : [],
        status: downloadItem.status || 'downloading',
        dateStarted: new Date().toISOString(),
        dateCompleted: null
      });
      this._saveData();
    }
  }

  updateDownloadHistory(id, patch) {
    const entry = this.data.downloadHistory.find(d => d.id === id);
    if (entry) {
      Object.assign(entry, patch);
      if (patch.status === 'completed' && !entry.dateCompleted) {
        entry.dateCompleted = new Date().toISOString();
      }
      this._saveData();
      return entry;
    }
    return null;
  }

  updateDownloadHistoryStatus(id, status) {
    const entry = this.data.downloadHistory.find(d => d.id === id);
    if (entry) {
      entry.status = status;
      if (status === 'completed') {
        entry.dateCompleted = new Date().toISOString();
      }
      this._saveData();
    }
  }

  getPartialDownloads() {
    return this.data.downloadHistory.filter(d => d.status === 'interrupted' || d.status === 'error');
  }

  removeDownloadFromHistory(id) {
    this.data.downloadHistory = this.data.downloadHistory.filter(d => d.id !== id);
    this._saveData();
  }

  getInstalledGames() {
    return this.data.installedGames;
  }

  addInstalledGame(game) {
    const executablePath = String(game.executablePath || '').trim();
    const normalizedExecutablePath = path.resolve(executablePath).toLowerCase();
    const existing = this.data.installedGames.find((entry) => (
      path.resolve(String(entry.executablePath || '')).toLowerCase() === normalizedExecutablePath
    ));
    if (existing) {
      Object.assign(existing, {
        name: game.name || existing.name,
        executablePath,
        size: game.size || existing.size || null,
        year: game.year || existing.year || null,
        source: game.source || existing.source || 'Manual',
        thumbnail: game.thumbnail || existing.thumbnail || null
      });
      this._saveData();
      return existing;
    }

    const installedGame = {
      id: randomUUID(),
      name: game.name,
      executablePath,
      size: game.size || null,
      year: game.year || null,
      source: game.source || 'Manual',
      thumbnail: game.thumbnail || null,
      dateAdded: new Date().toISOString()
    };
    this.data.installedGames.push(installedGame);
    this._saveData();
    return installedGame;
  }

  removeInstalledGame(id) {
    this.data.installedGames = this.data.installedGames.filter(g => g.id !== id);
    this._saveData();
  }

  updateInstalledGame(id, patch) {
    const game = this.data.installedGames.find(g => g.id === id);
    if (game) {
      Object.assign(game, patch);
      this._saveData();
      return game;
    }
    return null;
  }
}

module.exports = new Database();
