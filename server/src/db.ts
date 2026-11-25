import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  color TEXT NOT NULL, passwordHash TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection TEXT NOT NULL, parentId TEXT REFERENCES docs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_scope ON docs(workspaceId, collection, parentId, position);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folderId TEXT REFERENCES docs(id) ON DELETE SET NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_scope ON media(workspaceId, createdAt);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, directKey TEXT UNIQUE,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, lastReadSeq INTEGER NOT NULL DEFAULT 0, joinedAt INTEGER NOT NULL,
  PRIMARY KEY (conversationId, userId)
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  senderId TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, replyToId TEXT,
  createdAt INTEGER NOT NULL, editedAt INTEGER, deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversationId, seq);
CREATE TABLE IF NOT EXISTS reactions (
  messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL,
  PRIMARY KEY (messageId, userId, emoji)
);
CREATE TABLE IF NOT EXISTS chat_files (
  id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  uploaderId TEXT NOT NULL REFERENCES users(id), messageId TEXT REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
  filename TEXT NOT NULL, createdAt INTEGER NOT NULL
);
`;

export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.raw = new DatabaseSync(path.join(dataDir, 'studio.db'));
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first release. Safe to run on every start; existing rows are kept. */
  private migrate(): void {
    const added: [table: string, column: string, definition: string][] = [
      ['workspaces', 'photo', 'TEXT'],
      ['workspaces', 'photoMime', 'TEXT'],
      ['users', 'googleSub', 'TEXT'],
      ['users', 'email', 'TEXT'],
      ['conversations', 'description', "TEXT NOT NULL DEFAULT ''"],
      ['conversations', 'imageFilename', 'TEXT'],
      ['conversations', 'imageMime', 'TEXT'],
    ];
    for (const [table, column, definition] of added) {
      const columns = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some((c) => c.name === column)) {
        this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
    this.raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(googleSub)');
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  /** Runs `work` atomically. `work` must be synchronous. */
  tx<T>(work: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}
