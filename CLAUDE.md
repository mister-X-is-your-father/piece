# PIECE — Precise Integrated Expert Collaboration Engine

正確な統合型専門家協調エンジン。マルチエージェントでコードベースを深く分析し、ファクトチェック済みの正確な回答を提供。使うほど賢くなる。

## Development Directive

**VISION.md** に目指すべき姿・品質基準・開発サイクルを定義している。毎セッション参照すること。
開発サイクル: 現状診断 → 目標設定 → 実装 → 振り返り。理想とのギャップを埋め続ける。

## Architecture

5種のAIエージェントが協業:
- **Orchestrator**: 質問ルーティング・回答統合（プロジェクト地図のみ保持）
- **Specialist**: 担当領域の深い分析・回答（狭く深く、コンテキスト集中）
- **Fact Checker**: 全回答の根拠を実コードと突合検証（独立した第三者）
- **Investigator**: 謎を自律的に調査し知識を生成（自律成長）
- **Flow Tracer**: E2Eフローをモジュール横断で追跡

## Knowledge Brain (SQLite)

`.scribe/knowledge.db` に知識を蓄積:
- **Synapse Engine** — N-gram + concept展開 + 拡散活性化 + ヘッブ学習
- **Multi-Strategy Search** — 5戦略並行検索（synapse, structural, temporal, graph_walk, tag_cluster）
- **Atomic Knowledge** — 原子的事実 + 証明チェイン + 矛盾検出
- **MECE Matrix** — 組み合わせテーブルで知識の網羅性保証
- **Concept Mesh** — 日英クロス言語類義語ネットワーク（自動成長）

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
- Claude Code CLI backend (APIキー不要、定額課金対応)
- better-sqlite3 (knowledge DB)
- Commander for CLI
- Zod for validation

## Key Files

- `src/agents/` — エージェントシステム（5種）
- `src/agents/prompts/` — 各エージェントのプロンプトテンプレート
- `src/knowledge/` — SQLite知識DB + Synapse検索 + Atomic + MECE
- `src/analyzer/` — コード分析パイプライン
- `src/generator/` — ドキュメント生成
- `src/config/schema.ts` — 全データ型定義（Zod）

## Growth Cycle

```
ask → DB検索(multi-strategy) → 知識十分 → 即答（AI呼び出しなし）
                                ↓ 不足
                             AI回答 → 新知識をDB保存 → concept mesh成長
                                ↓
                             investigate → 謎を調査 → 知識追加 → ヘッブ学習
```
