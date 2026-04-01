import type Database from "better-sqlite3";
import { getKnowledgeDB, generateId } from "./db.js";
import type { Mystery, MysteryInsert, MysteryStatus } from "./schemas.js";

export class MysteryStore {
  private db: Database.Database;

  constructor(scribePath: string) {
    this.db = getKnowledgeDB(scribePath);
  }

  insertMystery(input: MysteryInsert): Mystery {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO mysteries (id, title, description, context, priority, specialist, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.description,
        input.context ?? null,
        input.priority ?? 5,
        input.specialist ?? null,
        input.source
      );
    return this.getMystery(id)!;
  }

  getMystery(id: string): Mystery | null {
    return (
      (this.db
        .prepare("SELECT * FROM mysteries WHERE id = ?")
        .get(id) as Mystery | undefined) ?? null
    );
  }

  listMysteries(filter?: {
    status?: MysteryStatus;
    specialist?: string;
    limit?: number;
  }): Mystery[] {
    let sql = "SELECT * FROM mysteries WHERE 1=1";
    const params: unknown[] = [];

    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.specialist) {
      sql += " AND specialist = ?";
      params.push(filter.specialist);
    }

    sql += " ORDER BY priority DESC, created_at DESC";

    if (filter?.limit) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    return this.db.prepare(sql).all(...params) as Mystery[];
  }

  updateMystery(
    id: string,
    update: Partial<Pick<Mystery, "title" | "description" | "priority" | "status" | "specialist">>
  ): void {
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (update.title !== undefined) {
      sets.push("title = ?");
      params.push(update.title);
    }
    if (update.description !== undefined) {
      sets.push("description = ?");
      params.push(update.description);
    }
    if (update.priority !== undefined) {
      sets.push("priority = ?");
      params.push(update.priority);
    }
    if (update.status !== undefined) {
      sets.push("status = ?");
      params.push(update.status);
    }
    if (update.specialist !== undefined) {
      sets.push("specialist = ?");
      params.push(update.specialist);
    }

    params.push(id);
    this.db
      .prepare(`UPDATE mysteries SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  resolveMystery(id: string, resolutionNodeId: string): void {
    this.db
      .prepare(
        `UPDATE mysteries
         SET status = 'resolved', resolution_node_id = ?, resolved_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(resolutionNodeId, id);
  }

  getNextToInvestigate(): Mystery | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM mysteries WHERE status = 'open' ORDER BY priority DESC, created_at ASC LIMIT 1"
        )
        .get() as Mystery | undefined) ?? null
    );
  }

  setInvestigating(id: string): void {
    this.db
      .prepare(
        "UPDATE mysteries SET status = 'investigating', updated_at = datetime('now') WHERE id = ?"
      )
      .run(id);
  }

  getStats(): {
    open: number;
    investigating: number;
    resolved: number;
    total: number;
  } {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) as count FROM mysteries GROUP BY status"
      )
      .all() as Array<{ status: string; count: number }>;

    const stats = { open: 0, investigating: 0, resolved: 0, total: 0 };
    for (const row of rows) {
      if (row.status in stats) {
        (stats as Record<string, number>)[row.status] = row.count;
      }
      stats.total += row.count;
    }
    return stats;
  }
}
