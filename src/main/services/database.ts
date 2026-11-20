import Database from "better-sqlite3";
import { app } from "electron";
import { initializeDatabase } from "./database-schema";
import { join } from "path";

let db: Database.Database | null = null;

/** Where the file lives, for anyone who wants to open it with their own client. */
export function databasePath(): string {
  return join(app.getPath("userData"), "pallet.db");
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(databasePath());
    db.pragma("journal_mode = WAL");
    initializeDatabase(db);
  }
  return db;
}
