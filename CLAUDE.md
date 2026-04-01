# codebase-scribe

自律成長型ナレッジ共有ツール。マルチエージェントでコードベースを深く分析し、ファクトチェック済みの回答を提供。使うほど賢くなる。

## Architecture

5種のAIエージェントが協業:
- **Orchestrator**: 質問ルーティング・回答統合（プロジェクト地図のみ保持）
- **Specialist**: 担当領域の深い分析・回答（狭く深く、コンテキスト集中）
- **Fact Checker**: 全回答の根拠を実コードと突合検証（独立した第三者）
- **Investigator**: 謎を自律的に調査し知識を生成（自律成長）
- **Flow Tracer**: E2Eフローをモジュール横断で追跡

## Knowledge Brain (SQLite)

`.scribe/knowledge.db` に知識を蓄積:
- **knowledge_nodes** + FTS5全文検索 — 学んだ知識
- **node_links** — 知識の接続グラフ
- **mysteries** — 未解決の謎（優先度付きキュー）
- **flows** — E2Eフロー
- **query_cache** — 過去の質問・回答キャッシュ

## Commands

```bash
# Core
npm run dev -- analyze <path>              # コードベース分析
npm run dev -- analyze <path> --dry-run    # コスト見積もり
npm run dev -- ask <path> "question"       # 質問（知識DB→AI→ファクトチェック→知識保存）
npm run dev -- specialists [path]          # スペシャリスト一覧
npm run dev -- update <path>               # 差分更新

# Knowledge Brain
npm run dev -- investigate <path>          # 自律調査（謎を自動選択）
npm run dev -- investigate <path> --loop 5 # 5サイクル連続調査
npm run dev -- mysteries <path>            # 未解決の謎一覧
npm run dev -- mysteries <path> --add "X"  # 謎を手動追加
npm run dev -- flows <path>                # E2Eフロー一覧
npm run dev -- flows <path> --trace "X"    # 新規フロー追跡
npm run dev -- knowledge <path>            # 知識統計
npm run dev -- knowledge <path> --search X # 知識検索
npm run dev -- knowledge <path> --graph    # 接続グラフ
```

## Tech Stack

- TypeScript (ESM, NodeNext)
- Anthropic SDK for Claude API
- better-sqlite3 (knowledge DB)
- Commander for CLI
- Zod for validation

## Key Files

- `src/agents/` — エージェントシステム（5種）
- `src/agents/prompts/` — 各エージェントのプロンプトテンプレート
- `src/knowledge/` — SQLite知識DB + 4つのstore
- `src/analyzer/` — コード分析パイプライン
- `src/generator/` — ドキュメント生成
- `src/config/schema.ts` — 全データ型定義（Zod）

## Growth Cycle

```
ask → DB検索 → 知識十分 → 即答（AI呼び出しなし）
               ↓ 不足
            AI回答 → 新知識をDB保存 → 謎検出
               ↓
            investigate → 謎を調査 → 知識追加 → 謎解決
```
