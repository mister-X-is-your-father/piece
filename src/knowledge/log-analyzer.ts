/**
 * Log Analyzer: ログから原因を割り出す
 *
 * 1. ログファイル/出力を取り込み
 * 2. タイムスタンプ・レベル・メッセージをパース
 * 3. 時系列で並べて異常パターンを検出
 * 4. エラー前後のコンテキストから原因を推論
 * 5. 知識として保存
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { indexNodeTokens } from "./neuron.js";
import { logger } from "../utils/logger.js";

// --- Types ---

export interface LogEntry {
  timestamp: string | null;
  level: "error" | "warn" | "info" | "debug" | "unknown";
  message: string;
  source: string | null;    // ファイル名/サービス名
  lineNumber: number;       // ログファイル内の行番号
  raw: string;
}

export interface LogSession {
  id: string;
  name: string;
  entries: LogEntry[];
  source: string;           // ファイルパスor "stdin"
  ingested_at: string;
}

export interface LogPattern {
  type: "error_spike" | "recurring_error" | "cascade" | "timeout" | "anomaly";
  description: string;
  entries: LogEntry[];
  frequency: number;
}

// --- SQL Schema (migration v8) ---

export const MIGRATION_V8_SQL = `
  CREATE TABLE IF NOT EXISTS log_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    time_range_start TEXT,
    time_range_end TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS log_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
    timestamp TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT,
    line_number INTEGER NOT NULL,
    raw TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_log_entries_session ON log_entries(session_id, line_number);
  CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries(level);
  CREATE INDEX IF NOT EXISTS idx_log_entries_ts ON log_entries(timestamp);

  CREATE TABLE IF NOT EXISTS log_findings (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
    finding_type TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence_entries TEXT NOT NULL,
    severity INTEGER NOT NULL DEFAULT 5,
    knowledge_node_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// --- Log Parser ---

const LOG_PATTERNS = [
  // ISO timestamp + level: 2026-04-01T12:00:00.000Z [ERROR] message
  { regex: /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?)\s*\[?(ERROR|WARN|INFO|DEBUG|error|warn|info|debug)\]?\s*(.+)$/,
    groups: { ts: 1, level: 2, msg: 3 } },
  // Timestamp + level: [2026-04-01 12:00:00] ERROR: message
  { regex: /^\[?(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\]?\s*(ERROR|WARN|INFO|DEBUG|error|warn|info|debug):?\s*(.+)$/,
    groups: { ts: 1, level: 2, msg: 3 } },
  // Simple level prefix: ERROR message / [error] message
  { regex: /^\[?(ERROR|WARN|INFO|DEBUG|error|warn|info|debug)\]?:?\s*(.+)$/,
    groups: { ts: null, level: 1, msg: 2 } },
  // Stack trace lines
  { regex: /^\s+at\s+(.+)$/,
    groups: { ts: null, level: null, msg: 1 }, isStackTrace: true },
  // Python traceback
  { regex: /^(Traceback|File\s+"[^"]+"|.*Error:.+)$/,
    groups: { ts: null, level: null, msg: 1 }, isStackTrace: true },
];

export function parseLogLine(line: string, lineNum: number): LogEntry {
  for (const pattern of LOG_PATTERNS) {
    const match = line.match(pattern.regex);
    if (match) {
      const ts = pattern.groups.ts ? match[pattern.groups.ts as number] : null;
      const level = pattern.groups.level
        ? (match[pattern.groups.level as number]?.toLowerCase() as LogEntry["level"]) || "unknown"
        : (pattern as any).isStackTrace ? "error" : "unknown";
      const msg = match[pattern.groups.msg as number] || line;

      return { timestamp: ts, level, message: msg.trim(), source: null, lineNumber: lineNum, raw: line };
    }
  }

  return { timestamp: null, level: "unknown", message: line.trim(), source: null, lineNumber: lineNum, raw: line };
}

export function parseLogContent(content: string, source: string): LogEntry[] {
  const lines = content.split("\n");
  const entries: LogEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLogLine(line, i + 1);
    entry.source = source;
    entries.push(entry);
  }

  return entries;
}

// --- Pattern Detection ---

export function detectPatterns(entries: LogEntry[]): LogPattern[] {
  const patterns: LogPattern[] = [];

  // 1. Error spike: 短時間に大量のエラー
  const errors = entries.filter((e) => e.level === "error");
  if (errors.length >= 3) {
    // Check for consecutive errors
    for (let i = 0; i < errors.length - 2; i++) {
      const window = errors.slice(i, i + 3);
      const lineSpan = window[2].lineNumber - window[0].lineNumber;
      if (lineSpan <= 10) {
        patterns.push({
          type: "error_spike",
          description: `Error spike: ${window.length} errors in ${lineSpan} lines`,
          entries: window,
          frequency: 1,
        });
        break;
      }
    }
  }

  // 2. Recurring error: 同じメッセージが繰り返し
  const msgCount = new Map<string, LogEntry[]>();
  for (const e of errors) {
    // Normalize: remove numbers/hashes for grouping
    const normalized = e.message.replace(/\b[0-9a-f]{8,}\b/g, "<id>").replace(/\d+/g, "<n>");
    if (!msgCount.has(normalized)) msgCount.set(normalized, []);
    msgCount.get(normalized)!.push(e);
  }
  for (const [msg, group] of msgCount) {
    if (group.length >= 2) {
      patterns.push({
        type: "recurring_error",
        description: `Recurring error (${group.length}x): ${group[0].message.slice(0, 80)}`,
        entries: group,
        frequency: group.length,
      });
    }
  }

  // 3. Cascade: エラーの後に連続してエラーが発生
  for (let i = 0; i < entries.length - 3; i++) {
    if (entries[i].level === "error") {
      const following = entries.slice(i + 1, i + 5);
      const followingErrors = following.filter((e) => e.level === "error" || e.level === "warn");
      if (followingErrors.length >= 2) {
        patterns.push({
          type: "cascade",
          description: `Error cascade starting at line ${entries[i].lineNumber}`,
          entries: [entries[i], ...followingErrors],
          frequency: 1,
        });
        break;
      }
    }
  }

  // 4. Timeout patterns
  const timeouts = entries.filter((e) =>
    e.message.toLowerCase().includes("timeout") ||
    e.message.toLowerCase().includes("timed out") ||
    e.message.includes("ETIMEDOUT")
  );
  if (timeouts.length > 0) {
    patterns.push({
      type: "timeout",
      description: `Timeout detected (${timeouts.length}x)`,
      entries: timeouts,
      frequency: timeouts.length,
    });
  }

  return patterns;
}

// --- Log Store ---

export class LogStore {
  constructor(private db: Database.Database) {}

  ingestLog(name: string, content: string, source: string): LogSession {
    const entries = parseLogContent(content, source);
    const id = generateId();

    const errors = entries.filter((e) => e.level === "error");
    const timestamps = entries.filter((e) => e.timestamp).map((e) => e.timestamp!).sort();

    this.db.prepare(
      `INSERT INTO log_sessions (id, name, source, entry_count, error_count, time_range_start, time_range_end)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, source, entries.length, errors.length,
      timestamps[0] || null, timestamps[timestamps.length - 1] || null);

    const stmt = this.db.prepare(
      `INSERT INTO log_entries (id, session_id, timestamp, level, message, source, line_number, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of entries) {
      stmt.run(generateId(), id, e.timestamp, e.level, e.message, e.source, e.lineNumber, e.raw);
    }

    return { id, name, entries, source, ingested_at: new Date().toISOString() };
  }

  getSession(id: string): LogSession | null {
    const session = this.db.prepare("SELECT * FROM log_sessions WHERE id = ?").get(id) as any;
    if (!session) return null;
    const entries = this.db
      .prepare("SELECT * FROM log_entries WHERE session_id = ? ORDER BY line_number")
      .all(id) as LogEntry[];
    return { ...session, entries };
  }

  listSessions(): Array<{ id: string; name: string; entry_count: number; error_count: number; created_at: string }> {
    return this.db.prepare("SELECT * FROM log_sessions ORDER BY created_at DESC").all() as any[];
  }

  saveFinding(sessionId: string, finding: {
    type: string; description: string; evidenceEntries: number[]; severity: number;
  }): string {
    const id = generateId();
    this.db.prepare(
      `INSERT INTO log_findings (id, session_id, finding_type, description, evidence_entries, severity)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, finding.type, finding.description,
      JSON.stringify(finding.evidenceEntries), finding.severity);
    return id;
  }

  /**
   * Save log analysis results as knowledge nodes.
   */
  saveAsKnowledge(
    sessionId: string,
    patterns: LogPattern[],
    analysisResult?: string
  ): number {
    let count = 0;

    for (const p of patterns) {
      const nodeId = generateId();
      const content = [
        `Pattern: ${p.type}`,
        `Description: ${p.description}`,
        `Frequency: ${p.frequency}`,
        `Evidence lines: ${p.entries.map((e) => e.lineNumber).join(", ")}`,
        `Sample: ${p.entries[0]?.raw || ""}`,
      ].join("\n");

      this.db.prepare(
        `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, source_question)
         VALUES (?, ?, ?, 'fact', 0.8, ?)`
      ).run(nodeId, content, `Log: ${p.description.slice(0, 60)}`, `log:${sessionId}`);

      this.db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, 'log')").run(nodeId);
      this.db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nodeId, p.type);
      indexNodeTokens(this.db, nodeId, content, p.description, ["log", p.type]);

      this.saveFinding(sessionId, {
        type: p.type,
        description: p.description,
        evidenceEntries: p.entries.map((e) => e.lineNumber),
        severity: p.type === "error_spike" || p.type === "cascade" ? 8 : 5,
      });

      count++;
    }

    return count;
  }

  getStats(): { sessions: number; totalEntries: number; totalErrors: number; findings: number } {
    const sessions = (this.db.prepare("SELECT COUNT(*) as c FROM log_sessions").get() as any).c;
    const entries = (this.db.prepare("SELECT COALESCE(SUM(entry_count), 0) as c FROM log_sessions").get() as any).c;
    const errors = (this.db.prepare("SELECT COALESCE(SUM(error_count), 0) as c FROM log_sessions").get() as any).c;
    const findings = (this.db.prepare("SELECT COUNT(*) as c FROM log_findings").get() as any).c;
    return { sessions, totalEntries: entries, totalErrors: errors, findings };
  }
}
