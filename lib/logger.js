/**
 * Logger — structured NDJSON log file writer with rotation.
 *
 * Features:
 *   - NDJSON format (one JSON object per line)
 *   - Size-based file rotation (default 10MB)
 *   - Configurable retention (number of rotated files to keep)
 *   - Integrates with Supervisor 'log' events
 */

import fs from 'fs';
import path from 'path';

/**
 * @typedef {object} LoggerConfig
 * @property {string} dir - log directory
 * @property {string} [filename] - log file name (default: 'swarm.log')
 * @property {number} [maxSizeBytes] - max file size before rotation (default: 10MB)
 * @property {number} [maxFiles] - number of rotated files to keep (default: 5)
 * @property {boolean} [stdout] - also write to stdout (default: false)
 */

export class Logger {
  /**
   * @param {LoggerConfig} config
   */
  constructor(config) {
    if (!config.dir) throw new Error('Logger requires dir');

    this.dir = config.dir;
    this.filename = config.filename || 'swarm.log';
    this.maxSizeBytes = config.maxSizeBytes || 10 * 1024 * 1024; // 10MB
    this.maxFiles = config.maxFiles || 5;
    this.stdout = config.stdout || false;

    this._fd = null;
    this._currentSize = 0;
    this._logPath = path.join(this.dir, this.filename);
  }

  /**
   * Open the log file for writing.
   * Creates the directory if it doesn't exist.
   */
  open() {
    fs.mkdirSync(this.dir, { recursive: true });

    // Check existing file size
    try {
      const stat = fs.statSync(this._logPath);
      this._currentSize = stat.size;
    } catch {
      this._currentSize = 0;
    }

    this._fd = fs.openSync(this._logPath, 'a');
  }

  /**
   * Write a structured log entry.
   * @param {string} event - event name
   * @param {object} [data] - additional data
   */
  write(event, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...data,
    };

    const line = JSON.stringify(entry) + '\n';
    const lineBytes = Buffer.byteLength(line);

    // Rotate if needed
    if (this._currentSize + lineBytes > this.maxSizeBytes) {
      this._rotate();
    }

    // Write
    if (this._fd !== null) {
      fs.writeSync(this._fd, line);
      this._currentSize += lineBytes;
    }

    if (this.stdout) {
      process.stdout.write(line);
    }
  }

  /**
   * Write a pre-formed log entry object (e.g., from supervisor 'log' event).
   * @param {object} entry - must have at least { ts, event }
   */
  writeEntry(entry) {
    const line = JSON.stringify(entry) + '\n';
    const lineBytes = Buffer.byteLength(line);

    if (this._currentSize + lineBytes > this.maxSizeBytes) {
      this._rotate();
    }

    if (this._fd !== null) {
      fs.writeSync(this._fd, line);
      this._currentSize += lineBytes;
    }

    if (this.stdout) {
      process.stdout.write(line);
    }
  }

  /**
   * Rotate log files.
   * swarm.log -> swarm.log.1 -> swarm.log.2 -> ... -> swarm.log.N (deleted)
   */
  _rotate() {
    // Close current file
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }

    // Shift existing rotated files
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this._logPath}.${i}`;
      const to = `${this._logPath}.${i + 1}`;
      try {
        if (i === this.maxFiles - 1) {
          // Delete the oldest
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
      } catch {
        // File doesn't exist — skip
      }
    }

    // Rotate current to .1
    try {
      fs.renameSync(this._logPath, `${this._logPath}.1`);
    } catch {
      // File doesn't exist — skip
    }

    // Open fresh file
    this._fd = fs.openSync(this._logPath, 'a');
    this._currentSize = 0;
  }

  /**
   * Close the log file.
   */
  close() {
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }
  }

  /**
   * Read back the current log file as an array of parsed entries.
   * Useful for debugging and testing.
   * @param {number} [limit] - max entries to return (from end)
   * @returns {object[]}
   */
  read(limit) {
    try {
      const content = fs.readFileSync(this._logPath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      const entries = lines.map(l => {
        try { return JSON.parse(l); }
        catch { return { raw: l }; }
      });
      if (limit) {
        return entries.slice(-limit);
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Get the path to the current log file.
   * @returns {string}
   */
  get logPath() {
    return this._logPath;
  }

  /**
   * Get the current file size.
   * @returns {number}
   */
  get size() {
    return this._currentSize;
  }

  /**
   * List all log files (current + rotated).
   * @returns {string[]}
   */
  listFiles() {
    const files = [this._logPath];
    for (let i = 1; i <= this.maxFiles; i++) {
      const rotated = `${this._logPath}.${i}`;
      if (fs.existsSync(rotated)) {
        files.push(rotated);
      }
    }
    return files;
  }
}

/**
 * Wire a Logger to a Supervisor's 'log' events.
 * @param {import('./supervisor.js').Supervisor} supervisor
 * @param {Logger} logger
 */
export function attachLogger(supervisor, logger) {
  supervisor.on('log', (entry) => {
    logger.writeEntry(entry);
  });
}
