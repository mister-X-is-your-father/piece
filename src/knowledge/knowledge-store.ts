import type Database from "better-sqlite3";
import { getKnowledgeDB, generateId } from "./db.js";
import type {
  KnowledgeNode,
  KnowledgeNodeInsert,
  NodeCitation,
  NodeCitationInsert,
  NodeLink,
  NodeLinkInsert,
  KnowledgeSearchResult,
  QueryCache,
  QueryCacheInsert,
} from "./schemas.js";

export class KnowledgeStore {
  private db: Database.Database;

  constructor(scribePath: string) {
    this.db = getKnowledgeDB(scribePath);
  }

  // --- Knowledge Nodes ---

  insertNode(input: KnowledgeNodeInsert): KnowledgeNode {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, specialist, source_question)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.content,
        input.summary,
        input.node_type,
        input.confidence ?? 0.5,
        input.specialist ?? null,
        input.source_question ?? null
      );

    // Insert tags
    const tags = input.tags ?? [];
    if (tags.length > 0) {
      const tagStmt = this.db.prepare(
        "INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)"
      );
      for (const tag of tags) {
        tagStmt.run(id, tag);
      }
    }

    return this.getNode(id)!;
  }

  getNode(id: string): KnowledgeNode | null {
    return (
      (this.db
        .prepare("SELECT * FROM knowledge_nodes WHERE id = ?")
        .get(id) as KnowledgeNode | undefined) ?? null
    );
  }

  updateNodeConfidence(id: string, confidence: number): void {
    this.db
      .prepare(
        "UPDATE knowledge_nodes SET confidence = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(confidence, id);
  }

  incrementAccessCount(id: string): void {
    this.db
      .prepare(
        "UPDATE knowledge_nodes SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?"
      )
      .run(id);
  }

  getNodesBySpecialist(specialist: string): KnowledgeNode[] {
    return this.db
      .prepare("SELECT * FROM knowledge_nodes WHERE specialist = ? ORDER BY confidence DESC")
      .all(specialist) as KnowledgeNode[];
  }

  getNodeCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM knowledge_nodes")
      .get() as { count: number };
    return row.count;
  }

  // --- Full-Text Search ---

  searchNodes(query: string, limit: number = 10): KnowledgeSearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT kn.*, rank
         FROM knowledge_nodes_fts fts
         JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
         WHERE knowledge_nodes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as (KnowledgeNode & { rank: number })[];

    return rows.map((row) => {
      const citations = this.getCitationsForNode(row.id);
      return {
        node: row,
        relevance: -row.rank, // FTS5 rank is negative, lower is better
        citations,
      };
    });
  }

  /**
   * Search for answer-worthy knowledge.
   * Combines FTS relevance with confidence and access frequency.
   */
  searchForAnswer(
    question: string,
    limit: number = 10
  ): KnowledgeSearchResult[] {
    // Tokenize for FTS5 OR query
    const tokens = question
      .split(/[\s、。？！?!,.;:]+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"`)
      .join(" OR ");

    if (!tokens) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT kn.*,
                  rank,
                  (kn.confidence * 10 + kn.access_count * 0.5 + (-rank) * 2) as score
           FROM knowledge_nodes_fts fts
           JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
           WHERE knowledge_nodes_fts MATCH ?
           ORDER BY score DESC
           LIMIT ?`
        )
        .all(tokens, limit) as (KnowledgeNode & {
        rank: number;
        score: number;
      })[];

      return rows.map((row) => {
        const citations = this.getCitationsForNode(row.id);
        return {
          node: row,
          relevance: row.score,
          citations,
        };
      });
    } catch {
      // FTS query syntax error
      return [];
    }
  }

  // --- Citations ---

  addCitation(input: NodeCitationInsert): NodeCitation {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO node_citations (id, node_id, file_path, start_line, end_line, code_snippet)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.node_id,
        input.file_path,
        input.start_line ?? null,
        input.end_line ?? null,
        input.code_snippet ?? null
      );
    return this.db
      .prepare("SELECT * FROM node_citations WHERE id = ?")
      .get(id) as NodeCitation;
  }

  getCitationsForNode(nodeId: string): NodeCitation[] {
    return this.db
      .prepare("SELECT * FROM node_citations WHERE node_id = ?")
      .all(nodeId) as NodeCitation[];
  }

  // --- Node Links ---

  linkNodes(input: NodeLinkInsert): NodeLink | null {
    const id = generateId();
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO node_links (id, source_id, target_id, link_type, description)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, input.source_id, input.target_id, input.link_type, input.description ?? null);
      return this.db
        .prepare("SELECT * FROM node_links WHERE id = ?")
        .get(id) as NodeLink | undefined ?? null;
    } catch {
      return null;
    }
  }

  getRelatedNodes(nodeId: string): KnowledgeNode[] {
    return this.db
      .prepare(
        `SELECT kn.* FROM knowledge_nodes kn
         JOIN node_links nl ON (nl.target_id = kn.id AND nl.source_id = ?)
                             OR (nl.source_id = kn.id AND nl.target_id = ?)
         GROUP BY kn.id`
      )
      .all(nodeId, nodeId) as KnowledgeNode[];
  }

  getNodeLinks(nodeId: string): NodeLink[] {
    return this.db
      .prepare(
        "SELECT * FROM node_links WHERE source_id = ? OR target_id = ?"
      )
      .all(nodeId, nodeId) as NodeLink[];
  }

  // --- Tags ---

  getNodeTags(nodeId: string): string[] {
    const rows = this.db
      .prepare("SELECT tag FROM node_tags WHERE node_id = ?")
      .all(nodeId) as { tag: string }[];
    return rows.map((r) => r.tag);
  }

  getNodesByTag(tag: string): KnowledgeNode[] {
    return this.db
      .prepare(
        `SELECT kn.* FROM knowledge_nodes kn
         JOIN node_tags nt ON nt.node_id = kn.id
         WHERE nt.tag = ?`
      )
      .all(tag) as KnowledgeNode[];
  }

  getAllTags(): Array<{ tag: string; count: number }> {
    return this.db
      .prepare(
        "SELECT tag, COUNT(*) as count FROM node_tags GROUP BY tag ORDER BY count DESC"
      )
      .all() as Array<{ tag: string; count: number }>;
  }

  // --- Query Cache ---

  findSimilarQuery(question: string): QueryCache | null {
    const tokens = question
      .split(/[\s、。？！?!,.;:]+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"`)
      .join(" OR ");

    if (!tokens) return null;

    try {
      const row = this.db
        .prepare(
          `SELECT qc.*
           FROM query_cache_fts fts
           JOIN query_cache qc ON qc.rowid = fts.rowid
           WHERE query_cache_fts MATCH ?
           ORDER BY rank
           LIMIT 1`
        )
        .get(tokens) as QueryCache | undefined;

      if (row) {
        // Increment hit count
        this.db
          .prepare(
            "UPDATE query_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE id = ?"
          )
          .run(row.id);
      }

      return row ?? null;
    } catch {
      return null;
    }
  }

  cacheQuery(input: QueryCacheInsert): QueryCache {
    const id = generateId();
    const normalized = input.question
      .toLowerCase()
      .replace(/[？！?!。、,.]/g, "")
      .trim();

    this.db
      .prepare(
        `INSERT INTO query_cache
         (id, question, question_normalized, answer, specialists_consulted, fact_check_summary, knowledge_node_ids, investigation_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.question,
        normalized,
        input.answer,
        JSON.stringify(input.specialists_consulted),
        input.fact_check_summary ?? null,
        JSON.stringify(input.knowledge_node_ids ?? []),
        input.investigation_method ?? null
      );

    return this.db
      .prepare("SELECT * FROM query_cache WHERE id = ?")
      .get(id) as QueryCache;
  }

  getQueryCacheStats(): { total: number; totalHits: number } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as total, COALESCE(SUM(hit_count), 0) as totalHits FROM query_cache"
      )
      .get() as { total: number; totalHits: number };
    return row;
  }
}
