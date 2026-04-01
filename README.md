# PIECE

**Precise Integrated Expert Collaboration Engine**

複数のAI専門家が協調してコードベースを深く理解し、使うほど賢くなるナレッジエンジン。

```
piece analyze .          →  9つの専門家がコードを分析
piece ask . "認証は？"    →  専門家に聞く → 知識が蓄積
piece ask . "認証は？"    →  ⚡ 即答（AI呼び出しゼロ）
```

## Name

**P** — Precise (正確な)
**I** — Integrated (統合された)
**E** — Expert (専門家)
**C** — Collaboration (協調)
**E** — Engine (エンジン)

パズルのピースを1つずつ埋めるように、コードベースの知識を正確に、漏れなく組み上げていく。全ピースが揃った時、完全な理解が完成する。

## Why PIECE?

AIにコードの質問をしても、毎回ゼロから読み直す。前回教えたことを覚えていない。

PIECEは違う:
- **学んだ知識を蓄積する** — 同じ質問には即答
- **専門家が分担する** — 1つのAIが全部知ろうとしない。各領域のスペシャリストが狭く深く
- **根拠を示す** — 全回答にソースコード引用 + ファクトチェック
- **自律的に成長する** — 謎を見つけ、自分で調査し、知識を埋めていく

## Architecture

```
                    ┌───────────────────────┐
                    │     Orchestrator      │  質問を受け、担当を判断
                    └───────────┬───────────┘
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │ Specialist A │ │ Specialist B │ │ Specialist C │
      │ 認証モジュール │ │ DB層         │ │ API routes   │
      └──────────────┘ └──────────────┘ └──────────────┘
              │                 │                 │
              └─────────────────┼─────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │    Fact Checker       │  回答を実コードと突合検証
                    └───────────────────────┘
```

5種のAIエージェント:

| Agent | Role |
|-------|------|
| **Orchestrator** | 質問ルーティング・回答統合 |
| **Specialist** | 担当領域の深い分析・回答 |
| **Fact Checker** | 全回答を実コードと突合検証 |
| **Investigator** | 謎を自律的に調査→知識生成 |
| **Flow Tracer** | E2Eフローをモジュール横断追跡 |

## Knowledge Brain

知識は **Markdown** (source of truth) + **SQLite** (検索インデックス) の二層構造。

```
.scribe/vault/                  ← Obsidianで開ける。人間もAIも直接読める
  ├── MOC.md                    ← 知識の地図
  ├── src-auth/
  │   ├── JWT認証の仕組み.md     ← [[リンク]]で繋がる
  │   └── ミドルウェア.md
  └── daily/
      └── 2026-04-01.md         ← その日の学習ログ

.scribe/knowledge.db            ← 検索インデックス（消しても再構築可能）
```

### なぜ二層構造なのか

Markdownだけでも基本的な知識管理はできる。grepで検索し、`[[リンク]]`で繋ぎ、Gitで履歴を追える。知識が100ノード程度ならそれで十分。

SQLiteが必要になるのは以下の場面:

| 場面 | Markdownだけ | SQLite併用 |
|------|-------------|-----------|
| 「認証」で検索 | grep → ヒットする | 同じ |
| 「セキュリティ」で検索 | grep → **ヒットしない**（「認証」としか書いてない） | concept展開 → 「認証」にも**ヒットする** |
| よく一緒に使う知識の優先 | 判断できない | ヘッブ学習でweight上昇 → 上位に出る |
| 「何を知らないか」の追跡 | 人間が目視で判断 | MECEセルのクエリ → 自動でmystery生成 |
| 10,000ノードから検索 | grepが遅くなる | インデックスで一定速度 |
| confidence 0.8以上だけ | 全ファイル読む | `WHERE confidence > 0.8` 一瞬 |
| 類似質問のキャッシュ | ファイル名で部分一致？ | Jaccard類似度60%以上でHIT |

**まとめると:**
- **Markdown** = 書く・読む・見る・共有する層。人間にもAIにもアクセスしやすい
- **SQLite** = 検索・学習・計算する層。知識が増えるほど価値が出る
- SQLiteが消えても `piece reindex` で全Markdownから再構築できる。5秒で復活する

小さく始めてMarkdownだけで運用し、知識が増えてきたらSQLiteの恩恵を受ける設計になっている。

### Neuron Search Engine

脳科学にインスパイアされた検索エンジン（SQLite層）:

- **N-gram Tokenizer** — 日本語(bigram/trigram) + 英語(word-level)。FTS5のUnicode61トークナイザーでは日本語が全くヒットしなかった問題を解決
- **Concept Mesh** — 日英クロス言語の類義語ネットワーク。「セキュリティ」→「auth」→「認証」のように概念を展開。初期69ペアの手動シード + 使うたびにco-occurrenceで自動成長
- **Spreading Activation** — 直接マッチしなくても、リンクを辿って関連知識を活性化。複数の弱い信号が束になると強い活性化になる（脳のシナプス伝達と同じ原理）
- **Hebbian Learning** — 「一緒に使われたニューロンは繋がりが強くなる」。同じ回答に使われた知識ノード同士のリンクweightが+0.1（上限5.0）。7日以上使われないリンクは徐々に減衰（下限0.1）

### Multi-Strategy Search

5つの検索戦略を並行実行し、結果を統合する。各戦略が異なる軸で知識空間をカバーするため、1つの戦略では見つからない知識も別の戦略で拾える。

| Strategy | Weight | Method | カバーする軸 |
|----------|--------|--------|------------|
| Neuron | 1.0 | N-gram + concept展開 + 拡散活性化 | 意味的一致 |
| Structural | 0.8 | ファイルパス・関数名で逆引き | 構造的一致 |
| Temporal | 0.4 | 最近アクセスされた知識を優先 | 文脈的一致 |
| Graph Walk | 0.6 | ヒットしたノードの隣接を探索 | 関係的一致 |
| Tag Cluster | 0.7 | タグ集合のJaccard類似度 | 分類的一致 |

複数戦略でヒットしたノードにクロスボーナス（2戦略で1.2倍、3戦略で1.4倍）。`createStrategy()`で独自戦略をプラグイン追加可能。

### MECE Matrix

組み合わせテーブルで知識の漏れを検出する。対象（関数・モジュール・フロー）× 観点（正常系・異常系・境界値...）の全セルを列挙し、未調査のセルを可視化する。

```
handleLogin     │ 正常系 │ 異常系 │ 境界値 │
────────────────┼────────┼────────┼────────┤
入力検証         │  ✅   │  ✅   │  ❌   │
処理ロジック      │  ✅   │  ❌   │  ❌   │
戻り値          │  ✅   │  ✅   │  ❌   │
エラーハンドリング │  ❌   │  ❌   │  ❌   │

→ ❌ = 自動でmysteryに登録 → investigateで埋めていく
```

5種のビルトインテンプレート（function, module, flow, security, data lifecycle）+ カスタムテンプレート対応。

## Growth Cycle

```
ask → 知識DBに十分な情報あり → ⚡ 即答（AI呼び出しゼロ）
        ↓ 不足
      AI回答 → 新知識をmarkdownに保存 → SQLite自動インデックス
        ↓
      ファクトチェック → 未検証 → 謎(mystery)として登録
        ↓
      investigate → 謎を自律調査 → 知識追加 → concept mesh成長
        ↓
      同じ質問が来たら → キャッシュHIT → コスト$0
```

## Install

```bash
git clone https://github.com/mister-X-is-your-father/piece.git
cd piece
npm install
```

## Usage

```bash
# コードベースを分析（Specialist自動生成）
npm run dev -- analyze /path/to/project

# 質問（知識DB → AI → ファクトチェック → 知識保存）
npm run dev -- ask /path/to/project "認証はどう動いてる？"

# スペシャリスト一覧
npm run dev -- specialists /path/to/project

# 差分更新
npm run dev -- update /path/to/project

# 自律調査（最優先の謎を自動選択）
npm run dev -- investigate /path/to/project

# 5サイクル連続調査
npm run dev -- investigate /path/to/project --loop 5

# 未解決の謎一覧
npm run dev -- mysteries /path/to/project

# E2Eフロー追跡
npm run dev -- flows /path/to/project --trace "ログインフロー"

# 知識統計
npm run dev -- knowledge /path/to/project

# 知識検索
npm run dev -- knowledge /path/to/project --search "認証"

# Obsidian vaultに書き出し
npm run dev -- vault export /path/to/project

# Obsidian vaultから取り込み
npm run dev -- vault import /path/to/project /path/to/vault

# 双方向同期
npm run dev -- vault sync /path/to/project

# SQLiteインデックス再構築
npm run dev -- reindex /path/to/project
```

## Backend

デフォルトで **Claude Code CLI** をバックエンドに使用。APIキー不要、定額課金(Max)プランで動作。

```bash
# デフォルト: Claude Code CLI（APIキー不要）
npm run dev -- analyze .

# 直接API呼び出し（ANTHROPIC_API_KEY必要）
npm run dev -- --backend api analyze .
```

## Tech Stack

- TypeScript (ESM)
- Claude Code CLI / Anthropic SDK
- better-sqlite3 + FTS5
- Commander (CLI)
- Zod (validation)
- gray-matter (frontmatter)

## License

MIT
