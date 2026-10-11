import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, chmodSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { integrity } from './database.js';

// Must run before openStore applies migrations. No workers have started yet.
export async function backupBefore006(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get())
      throw new Error('Existing database lacks migration ledger');
    if (source.prepare('SELECT 1 FROM schema_migrations WHERE version=6').get()) return null;
    integrity(source);
    const root = join(dirname(path), 'backups');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(root, 'pre-006-'));
    chmodSync(directory, 0o700);
    const temporary = join(directory, 'coachai.db.pending');
    await backup(source, temporary);
    chmodSync(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary, { readOnly: true });
    try { integrity(snapshot); } finally { snapshot.close(); }
    integrity(source);
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const destination = join(directory, 'coachai.db');
    renameSync(temporary, destination);
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return destination;
  } finally { source.close(); }
}
