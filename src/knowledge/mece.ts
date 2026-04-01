/**
 * MECE Coverage Matrix System
 *
 * 知識の網羅性を組み合わせテーブルで保証する。
 *
 * 考え方:
 *   対象(関数、モジュール、フロー) × 観点(軸) の全組み合わせを列挙し、
 *   各セルが「調査済み」か「未調査」かを追跡する。
 *   未調査セルは自動でmysteryに登録 → investigateで埋めていく。
 *
 * 軸テンプレート（カスタマイズ可能）:
 *
 *   function_axes: 関数単位の分析軸
 *     rows: [入力検証, 処理ロジック, 戻り値, エラーハンドリング, 副作用]
 *     cols: [正常系, 異常系, 境界値, null/undefined]
 *
 *   module_axes: モジュール単位の分析軸
 *     rows: [目的, 公開API, 内部実装, 依存関係, エラー戦略]
 *     cols: [設計意図, 実際の動作, テスト有無, ドキュメント有無]
 *
 *   flow_axes: E2Eフロー単位の分析軸
 *     rows: [トリガー, 各ステップ, 最終出力, エラーパス]
 *     cols: [正常フロー, エラーフロー, タイムアウト, 並行実行]
 *
 *   security_axes: セキュリティ観点
 *     rows: [入力サニタイズ, 認証, 認可, データ暗号化, ログ]
 *     cols: [実装有無, テスト有無, 脆弱性リスク]
 */

import type Database from "better-sqlite3";
import { generateId } from "./db.js";

// --- Types ---

export interface MeceMatrix {
  id: string;
  /** 対象（関数名、モジュール名、フロー名） */
  target: string;
  /** 対象のタイプ */
  target_type: "function" | "module" | "flow" | "custom";
  /** 軸テンプレート名 */
  template: string;
  /** 行ラベル */
  rows: string[];
  /** 列ラベル */
  cols: string[];
  /** 各セルの状態 */
  cells: MeceCell[];
  /** カバレッジ (0-1) */
  coverage: number;
  created_at: string;
  updated_at: string;
}

export interface MeceCell {
  row: string;
  col: string;
  status: "covered" | "uncovered" | "not_applicable" | "partial";
  /** このセルに対応するatom/knowledge_nodeのID */
  evidence_id: string | null;
  /** 簡易メモ */
  note: string | null;
}

// --- Axis Templates (拡張可能) ---

export interface AxisTemplate {
  name: string;
  description: string;
  target_type: "function" | "module" | "flow" | "custom";
  rows: string[];
  cols: string[];
}

export const BUILTIN_TEMPLATES: AxisTemplate[] = [
  {
    name: "function_analysis",
    description: "関数の全側面を網羅分析",
    target_type: "function",
    rows: ["入力検証", "処理ロジック", "戻り値", "エラーハンドリング", "副作用", "型制約"],
    cols: ["正常系", "異常系", "境界値", "null/undefined"],
  },
  {
    name: "module_analysis",
    description: "モジュールの設計・実装・品質を網羅",
    target_type: "module",
    rows: ["目的・責務", "公開API", "内部実装", "依存関係", "エラー戦略", "パフォーマンス"],
    cols: ["設計意図", "実際の動作", "テスト有無", "ドキュメント有無"],
  },
  {
    name: "flow_analysis",
    description: "E2Eフローの全パスを網羅",
    target_type: "flow",
    rows: ["トリガー", "入力処理", "中間ステップ", "出力処理", "後処理"],
    cols: ["正常フロー", "エラーフロー", "タイムアウト", "並行実行時"],
  },
  {
    name: "security_audit",
    description: "セキュリティ観点の網羅チェック",
    target_type: "custom",
    rows: ["入力サニタイズ", "認証チェック", "認可チェック", "データ暗号化", "監査ログ", "レート制限"],
    cols: ["実装有無", "テスト有無", "脆弱性リスク"],
  },
  {
    name: "data_lifecycle",
    description: "データのライフサイクルを網羅",
    target_type: "custom",
    rows: ["作成", "読み取り", "更新", "削除", "検索", "エクスポート"],
    cols: ["バリデーション", "権限チェック", "ログ記録", "エラー処理"],
  },
];

// --- SQL Schema (migration v4) ---

export const MIGRATION_V4_SQL = `
  -- MECE matrices
  CREATE TABLE IF NOT EXISTS mece_matrices (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('function', 'module', 'flow', 'custom')),
    template TEXT NOT NULL,
    rows_json TEXT NOT NULL,
    cols_json TEXT NOT NULL,
    coverage REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mece_target ON mece_matrices(target);
  CREATE INDEX IF NOT EXISTS idx_mece_type ON mece_matrices(target_type);

  -- MECE cells
  CREATE TABLE IF NOT EXISTS mece_cells (
    id TEXT PRIMARY KEY,
    matrix_id TEXT NOT NULL REFERENCES mece_matrices(id) ON DELETE CASCADE,
    row_label TEXT NOT NULL,
    col_label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uncovered' CHECK(status IN (
      'covered', 'uncovered', 'not_applicable', 'partial'
    )),
    evidence_id TEXT,
    note TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(matrix_id, row_label, col_label)
  );
  CREATE INDEX IF NOT EXISTS idx_mece_cells_matrix ON mece_cells(matrix_id);
  CREATE INDEX IF NOT EXISTS idx_mece_cells_status ON mece_cells(status);
`;

// --- MECE Store ---

export class MeceStore {
  constructor(private db: Database.Database) {}

  /** テンプレート一覧 */
  getTemplates(): AxisTemplate[] {
    return BUILTIN_TEMPLATES;
  }

  /** 対象×テンプレートでマトリクス作成。全セルをuncoveredで初期化 */
  createMatrix(target: string, template: AxisTemplate): MeceMatrix {
    const id = generateId();

    this.db
      .prepare(
        `INSERT INTO mece_matrices (id, target, target_type, template, rows_json, cols_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, target, template.target_type, template.name,
        JSON.stringify(template.rows), JSON.stringify(template.cols));

    // Initialize all cells as uncovered
    const cellStmt = this.db.prepare(
      `INSERT INTO mece_cells (id, matrix_id, row_label, col_label, status)
       VALUES (?, ?, ?, ?, 'uncovered')`
    );

    const cells: MeceCell[] = [];
    for (const row of template.rows) {
      for (const col of template.cols) {
        cellStmt.run(generateId(), id, row, col);
        cells.push({ row, col, status: "uncovered", evidence_id: null, note: null });
      }
    }

    return {
      id,
      target,
      target_type: template.target_type,
      template: template.name,
      rows: template.rows,
      cols: template.cols,
      cells,
      coverage: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /** セルを更新（coveredにする等） */
  updateCell(
    matrixId: string,
    row: string,
    col: string,
    status: MeceCell["status"],
    evidenceId?: string,
    note?: string
  ): void {
    this.db
      .prepare(
        `UPDATE mece_cells
         SET status = ?, evidence_id = COALESCE(?, evidence_id), note = COALESCE(?, note),
             updated_at = datetime('now')
         WHERE matrix_id = ? AND row_label = ? AND col_label = ?`
      )
      .run(status, evidenceId ?? null, note ?? null, matrixId, row, col);

    // Recalculate coverage
    this.recalcCoverage(matrixId);
  }

  /** カバレッジ再計算 */
  private recalcCoverage(matrixId: string): void {
    const total = (this.db
      .prepare("SELECT COUNT(*) as c FROM mece_cells WHERE matrix_id = ? AND status != 'not_applicable'")
      .get(matrixId) as { c: number }).c;

    const covered = (this.db
      .prepare("SELECT COUNT(*) as c FROM mece_cells WHERE matrix_id = ? AND status = 'covered'")
      .get(matrixId) as { c: number }).c;

    const coverage = total > 0 ? covered / total : 0;

    this.db
      .prepare("UPDATE mece_matrices SET coverage = ?, updated_at = datetime('now') WHERE id = ?")
      .run(coverage, matrixId);
  }

  /** マトリクス取得（セル付き） */
  getMatrix(id: string): MeceMatrix | null {
    const row = this.db
      .prepare("SELECT * FROM mece_matrices WHERE id = ?")
      .get(id) as any;
    if (!row) return null;

    const cells = this.db
      .prepare("SELECT * FROM mece_cells WHERE matrix_id = ? ORDER BY row_label, col_label")
      .all(id) as Array<{
        row_label: string; col_label: string; status: MeceCell["status"];
        evidence_id: string | null; note: string | null;
      }>;

    return {
      id: row.id,
      target: row.target,
      target_type: row.target_type,
      template: row.template,
      rows: JSON.parse(row.rows_json),
      cols: JSON.parse(row.cols_json),
      cells: cells.map(c => ({
        row: c.row_label, col: c.col_label, status: c.status,
        evidence_id: c.evidence_id, note: c.note,
      })),
      coverage: row.coverage,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** 対象名でマトリクス検索 */
  findMatrices(target?: string): MeceMatrix[] {
    let sql = "SELECT * FROM mece_matrices";
    const params: any[] = [];
    if (target) {
      sql += " WHERE target LIKE ?";
      params.push(`%${target}%`);
    }
    sql += " ORDER BY coverage ASC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.getMatrix(r.id)!).filter(Boolean);
  }

  /** 未カバーセル一覧（mystery候補） */
  getUncoveredCells(matrixId?: string): Array<{
    matrix_target: string;
    row: string;
    col: string;
    template: string;
  }> {
    let sql = `
      SELECT m.target as matrix_target, c.row_label as row, c.col_label as col, m.template
      FROM mece_cells c
      JOIN mece_matrices m ON m.id = c.matrix_id
      WHERE c.status = 'uncovered'
    `;
    const params: any[] = [];
    if (matrixId) {
      sql += " AND c.matrix_id = ?";
      params.push(matrixId);
    }
    sql += " ORDER BY m.target, c.row_label, c.col_label";

    return this.db.prepare(sql).all(...params) as any[];
  }

  /** 全マトリクスの集計 */
  getOverallStats(): {
    totalMatrices: number;
    totalCells: number;
    coveredCells: number;
    uncoveredCells: number;
    overallCoverage: number;
  } {
    const matrices = (this.db.prepare("SELECT COUNT(*) as c FROM mece_matrices").get() as { c: number }).c;
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM mece_cells WHERE status != 'not_applicable'").get() as { c: number }).c;
    const covered = (this.db.prepare("SELECT COUNT(*) as c FROM mece_cells WHERE status = 'covered'").get() as { c: number }).c;
    const uncovered = (this.db.prepare("SELECT COUNT(*) as c FROM mece_cells WHERE status = 'uncovered'").get() as { c: number }).c;

    return {
      totalMatrices: matrices,
      totalCells: total,
      coveredCells: covered,
      uncoveredCells: uncovered,
      overallCoverage: total > 0 ? covered / total : 0,
    };
  }

  /** マトリクスをテキストテーブルとして描画 */
  renderMatrix(matrix: MeceMatrix): string {
    const cellMap = new Map<string, MeceCell>();
    for (const cell of matrix.cells) {
      cellMap.set(`${cell.row}|${cell.col}`, cell);
    }

    // Calculate column widths
    const rowLabelWidth = Math.max(...matrix.rows.map(r => r.length), 6);
    const colWidth = Math.max(...matrix.cols.map(c => c.length), 4) + 2;

    // Header
    const lines: string[] = [];
    const header = " ".repeat(rowLabelWidth + 2) + "│ " +
      matrix.cols.map(c => c.padEnd(colWidth)).join("│ ");
    const separator = "─".repeat(rowLabelWidth + 2) + "┼" +
      matrix.cols.map(() => "─".repeat(colWidth + 1)).join("┼");

    lines.push(`MECE: ${matrix.target} (${matrix.template})`);
    lines.push(`Coverage: ${(matrix.coverage * 100).toFixed(1)}%`);
    lines.push("");
    lines.push(header);
    lines.push(separator);

    // Rows
    for (const row of matrix.rows) {
      const cells = matrix.cols.map(col => {
        const cell = cellMap.get(`${row}|${col}`);
        if (!cell) return "  ?  ";
        switch (cell.status) {
          case "covered": return " ✅  ";
          case "uncovered": return " ❌  ";
          case "partial": return " ⚠️  ";
          case "not_applicable": return " ─   ";
        }
      });
      lines.push(
        row.padEnd(rowLabelWidth + 2) + "│ " +
        cells.map(c => c.padEnd(colWidth)).join("│ ")
      );
    }

    return lines.join("\n");
  }
}
