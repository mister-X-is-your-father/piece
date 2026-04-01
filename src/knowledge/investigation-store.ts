import type Database from "better-sqlite3";
import { getKnowledgeDB, generateId } from "./db.js";
import type { Investigation, InvestigationInsert } from "./schemas.js";

export class InvestigationStore {
  private db: Database.Database;

  constructor(scribePath: string) {
    this.db = getKnowledgeDB(scribePath);
  }

  create(input: InvestigationInsert): Investigation {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO investigations (id, mystery_id, goal)
         VALUES (?, ?, ?)`
      )
      .run(id, input.mystery_id, input.goal);
    return this.get(id)!;
  }

  get(id: string): Investigation | null {
    return (
      (this.db
        .prepare("SELECT * FROM investigations WHERE id = ?")
        .get(id) as Investigation | undefined) ?? null
    );
  }

  start(id: string): void {
    this.db
      .prepare(
        "UPDATE investigations SET status = 'running', started_at = datetime('now') WHERE id = ?"
      )
      .run(id);
  }

  complete(
    id: string,
    findings: string,
    stats: {
      nodes_created: number;
      nodes_updated: number;
      mysteries_resolved: number;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE investigations
         SET status = 'completed', findings = ?, completed_at = datetime('now'),
             nodes_created = ?, nodes_updated = ?, mysteries_resolved = ?
         WHERE id = ?`
      )
      .run(
        findings,
        stats.nodes_created,
        stats.nodes_updated,
        stats.mysteries_resolved,
        id
      );
  }

  fail(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE investigations SET status = 'failed', findings = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(reason, id);
  }

  getRecent(limit: number = 10): Investigation[] {
    return this.db
      .prepare(
        "SELECT * FROM investigations ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as Investigation[];
  }

  getStats(): {
    total: number;
    completed: number;
    totalNodesCreated: number;
    totalMysteriesResolved: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                COALESCE(SUM(nodes_created), 0) as totalNodesCreated,
                COALESCE(SUM(mysteries_resolved), 0) as totalMysteriesResolved
         FROM investigations`
      )
      .get() as {
      total: number;
      completed: number;
      totalNodesCreated: number;
      totalMysteriesResolved: number;
    };
    return row;
  }
}
