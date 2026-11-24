const fs = require('fs');
const path = require('path');

function getFolderContents(directory, fileSystem = fs) {
  const entries = [];
  const errors = [];

  for (const name of fileSystem.readdirSync(directory)) {
    const entryPath = path.join(directory, name);

    try {
      const stat = fileSystem.lstatSync(entryPath);
      entries.push({
        name,
        path: entryPath,
        isDirectory: stat.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (error) {
      errors.push({
        name,
        code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      });
    }
  }

  return { entries, errors };
}

module.exports = { getFolderContents };
