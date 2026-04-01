# codebase-scribe

信頼性の高いナレッジ共有ツール。マルチエージェントアーキテクチャでコードベースを深く分析し、ファクトチェック済みの回答を提供する。

## Architecture

3種のAIエージェントが協業:
- **Orchestrator**: 質問ルーティング・回答統合（プロジェクト地図のみ保持）
- **Specialist**: 担当領域の深い分析・回答（狭く深く、コンテキスト集中）
- **Fact Checker**: 全回答の根拠を実コードと突合検証（独立した第三者）

## Commands

```bash
npm run dev -- analyze <path>          # コードベース分析
npm run dev -- analyze <path> --dry-run # コスト見積もり
npm run dev -- ask <path> "question"   # 質問（ファクトチェック付き）
npm run dev -- specialists [path]      # スペシャリスト一覧
npm run dev -- update <path>           # 差分更新
```

## Tech Stack

- TypeScript (ESM, NodeNext)
- Anthropic SDK for Claude API
- Commander for CLI
- Zod for validation

## Key Files

- `src/agents/` — エージェントシステム（核心）
- `src/agents/prompts/` — 各エージェントのプロンプトテンプレート
- `src/analyzer/` — コード分析パイプライン
- `src/generator/` — ドキュメント生成
- `src/responder/` — 質問応答（Specialist検索・コンテキスト構築）
- `src/config/schema.ts` — 全データ型定義（Zod）

## Output Structure

分析結果は `.scribe/` に出力:
- `index.md` — プロジェクト概要（Orchestrator用地図）
- `specialists/<name>/` — 各Specialist領域のドキュメント
- `_global-index.json` — キーワード→Specialist検索インデックス
