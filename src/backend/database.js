const fs = require('fs');
const path = require('path');
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
        downloadDirectory: path.join(app.getPath('downloads'), 'UniversalGameClient')
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
    if (exists) {
      // Update existing entry (e.g. resume → completed)
      Object.assign(exists, {
        filename: downloadItem.filename,
        url: downloadItem.url,
        totalBytes: downloadItem.totalBytes,
        downloadedBytes: downloadItem.downloadedBytes,
        source: downloadItem.meta?.source || exists.source,
        status: downloadItem.status || 'completed',
        dateCompleted: downloadItem.status === 'completed' ? new Date().toISOString() : exists.dateCompleted
      });
      this._saveData();
    } else {
      this.data.downloadHistory.unshift({
        id: downloadItem.id,
        filename: downloadItem.filename,
        url: downloadItem.url,
        totalBytes: downloadItem.totalBytes,
        downloadedBytes: downloadItem.downloadedBytes || 0,
        source: downloadItem.meta?.source || 'Unknown',
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
    this.data.installedGames.push({
      id: Date.now().toString(),
      name: game.name,
      executablePath: game.executablePath,
      dateAdded: new Date().toISOString()
    });
    this._saveData();
  }

  removeInstalledGame(id) {
    this.data.installedGames = this.data.installedGames.filter(g => g.id !== id);
    this._saveData();
  }
}

module.exports = new Database();
