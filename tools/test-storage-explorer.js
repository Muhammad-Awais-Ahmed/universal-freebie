const assert = require('assert');
const path = require('path');
const { getFolderContents } = require('../src/backend/storageExplorer');

const directory = path.resolve('D:\\Downloads');
const fileSystem = {
  readdirSync: (target) => {
    assert.strictEqual(target, directory);
    return ['game.zip', 'Config.Msi'];
  },
  lstatSync: (target) => {
    if (target === path.join(directory, 'Config.Msi')) {
      const error = new Error('Access denied');
      error.code = 'EPERM';
      throw error;
    }
    return {
      isDirectory: () => false,
      size: 128,
      mtime: { toISOString: () => '2025-01-02T03:04:05.000Z' },
    };
  },
};

assert.deepStrictEqual(getFolderContents(directory, fileSystem), {
  entries: [{
    name: 'game.zip',
    path: path.join(directory, 'game.zip'),
    isDirectory: false,
    size: 128,
    modifiedAt: '2025-01-02T03:04:05.000Z',
  }],
  errors: [{ name: 'Config.Msi', code: 'EPERM' }],
});

console.log('PASS: Storage Explorer lists readable items and reports inaccessible entries');
