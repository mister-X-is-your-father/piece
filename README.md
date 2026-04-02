# PIECE

**Precise Integrated Expert Collaboration Engine**

ビジネスドメインごとのAI専門家チームが、コードベースを深く理解し、使うほど賢くなるナレッジエンジン。

```
piece analyze .          →  ビジネスドメインごとに専門家を自動生成
piece app-map .          →  画面・API・操作・機能を自動検出
piece ask . "認証は？"    →  Manager AIが専門家に委任 → 全回答にFact Check
piece ask . "認証は？"    →  ⚡ 即答（AI呼び出しゼロ）
piece feedback . --rating 2 --text "違う"  →  学習して次回は正しくなる
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
- **専門家が分担する** — 「認証specialist」「freee連携specialist」のようにビジネスドメイン単位で狭く深く
- **全回答にFact Check** — 各specialistの回答を個別に実コードと突合検証
- **自律的に成長する** — 謎を見つけ、自分で調査し、知識を埋めていく
- **間違いから学ぶ** — フィードバックで原因分析 → confidence/weight/ルールを永続修正

## Architecture

```
              ┌──────────────────────────┐
              │      Manager AI          │  調査依頼・協力依頼を委任
              └────────────┬─────────────┘
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐
  │ 認証         │  │ freee連携     │  │ インポート    │
  │ specialist  │  │ specialist   │  │ specialist   │
  │ (investigate)│  │ (collaborate)│  │              │
  └──────┬──────┘  └──────┬───────┘  └──────────────┘
         │                │
         ▼                ▼
  ┌─────────────┐  ┌─────────────┐
  │ Fact Check  │  │ Fact Check  │  ← 全specialist個別にFact Check
  └──────┬──────┘  └──────┬──────┘
         └────────┬───────┘
                  ▼
         ┌───────────────┐
         │ Manager統合    │  Fact Check結果付きで回答統合
         └───────────────┘
```

6種のAIエージェント:

| Agent | Role |
|-------|------|
| **Manager AI** | ビジネスドメイン専門家への調査依頼・協力依頼・回答統合 |
| **Specialist** | 担当ドメインの深い分析・回答（全6検索戦略パイプラインを使用） |
| **Fact Checker** | 全specialistの全回答を個別に実コードと突合検証（必須） |
| **Investigator** | 謎を自律的に調査→知識生成 |
| **Flow Tracer** | E2Eフローをモジュール横断追跡 |
| **Feedback Analyzer** | フィードバックの原因分析→confidence/weight/ルール自動修正 |

### Manager AIの委任モデル

Manager AIは質問に応じて専門家に2種類の依頼を出す:

- **investigate（調査依頼）** — 主担当。この専門家がメインで回答する
- **collaborate（協力依頼）** — 副担当。関連する知識を補足提供する

例: 「freeeのOAuth連携は？」→ freee連携specialist(investigate) + 認証specialist(collaborate)

## Application Map

コードベースの画面・API・操作・機能を自動検出し、コードと接続する。

```bash
piece app-map /path/to/webapp
```

```
┌─ Application Map ─────────────────────┐
│                                        │
│  画面: ログイン画面 /login               │
│    ├── 操作: メール入力, PW入力, ログイン │
│    ├── handler: handleSubmit()          │
│    └── code: src/app/login/page.tsx     │
│                                        │
│  API: POST /api/auth/login              │
│    ├── handler: handleLogin()           │
│    └── code: src/app/api/auth/route.ts  │
│                                        │
│  機能: 認証                              │
│    ├── 画面: [ログイン, 登録]             │
│    ├── API: [POST /login, POST /reg]   │
│    └── service: AuthService             │
│                                        │
│  全要素がknowledge_nodesとして登録       │
│  → piece ask で横断検索可能             │
└────────────────────────────────────────┘
```

半自動フロー:
1. コードからパターンマッチで自動検出（Next.js/Express/FastAPI等対応）
2. AIが画面名・操作名・機能名を日本語で推論し、接続関係を推定
3. `.scribe/app-map/` にMarkdown出力（Obsidianで確認・編集可能）
4. ユーザーが修正 → `piece reindex` で取り込み → 精度向上

## Knowledge Brain

知識は **Markdown** (source of truth) + **SQLite** (検索インデックス) の二層構造。

```
.scribe/vault/                  ← Obsidianで開ける。人間もAIも直接読める
  ├── MOC.md                    ← 知識の地図
  ├── 認証/
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
| 意味的に似た知識を探す | 不可能 | ベクトル検索 (similarity 0.97) でヒット |
| よく一緒に使う知識の優先 | 判断できない | ヘッブ学習でweight上昇 → 上位に出る |
| 「何を知らないか」の追跡 | 人間が目視で判断 | MECEセルのクエリ → 自動でmystery生成 |
| 10,000ノードから検索 | grepが遅くなる | インデックスで一定速度 |
| confidence 0.8以上だけ | 全ファイル読む | `WHERE confidence > 0.8` 一瞬 |
| 類似質問のキャッシュ | ファイル名で部分一致？ | Jaccard類似度60%以上でHIT |

**まとめると:**
- **Markdown** = 書く・読む・見る・共有する層。人間にもAIにもアクセスしやすい
- **SQLite** = 検索・学習・計算する層。知識が増えるほど価値が出る
- SQLiteが消えても `piece reindex` で全Markdownから再構築できる

### Neuron Search Engine

脳科学にインスパイアされた検索エンジン（SQLite層）:

- **N-gram Tokenizer** — 日本語(bigram/trigram) + 英語(word-level)
- **Concept Mesh** — 日英クロス言語の類義語ネットワーク（自動成長）
- **Spreading Activation** — リンクを辿って関連知識を活性化
- **Hebbian Learning** — 一緒に使われた知識同士のリンクが強化
- **Vector Embeddings** — ローカル埋め込みモデル(all-MiniLM-L6-v2)による意味検索

### Multi-Strategy Search

6つの検索戦略を並行実行し、結果を統合する。各戦略が異なる軸で知識空間をカバー。

| Strategy | Weight | カバーする軸 |
|----------|--------|------------|
| Neuron | 1.0 | N-gram + concept展開 + 拡散活性化 |
| Vector | 1.2 | 埋め込みベクトルの意味的類似度 |
| Structural | 0.8 | ファイルパス・関数名で逆引き |
| Graph Walk | 0.6 | ヒットしたノードの隣接を探索 |
| Tag Cluster | 0.7 | タグ集合のJaccard類似度 |
| Temporal | 0.4 | 最近アクセスされた知識を優先 |

複数戦略でヒットしたノードにクロスボーナス（最大1.4倍）。`createStrategy()`で独自戦略をプラグイン追加可能。

### MECE Matrix

組み合わせテーブルで知識の漏れを検出する。

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

## Feedback Evolution

間違った回答からシステムが自律的に学ぶ。コンテキスト（会話履歴）に依存せず、仕組みとして永続化。

```
piece feedback . --rating 2 --text "JWTじゃなくてセッションベースだ"
```

```
フィードバック → Feedback Analyzer（原因分析AI）
  ├── 知識が間違い → confidence × 0.3 + 修正ノード作成
  ├── 知識不足    → mystery生成 → investigate予約
  ├── 検索が外れ  → concept weight修正
  ├── 引用不正確  → citation検証
  └── 統合が雑    → learned_rule追加
  ↓
全てSQLite + Markdownに永続化
  ↓
次回の同じ質問 → 自動的に正しい回答
```

| 何が変わるか | 永続化先 | 次回の効果 |
|------------|---------|-----------|
| ノードのconfidence | knowledge_nodes | 検索スコアに直接影響 |
| リンクのweight | node_links | 拡散活性化の強度変化 |
| 概念リンクの修正 | concept_links | 概念展開の結果が変わる |
| 回避/優先ルール | learned_rules | 検索時に自動適用 |
| 間違いキャッシュ | query_cache (DELETE) | 二度と同じ間違いを返さない |

## Growth Cycle

```
ask → 知識DBに十分な情報あり → ⚡ 即答（AI呼び出しゼロ）
        ↓ 不足
      Manager AI → specialist(investigate + collaborate)
        ↓
      各specialist回答 → 個別Fact Check（必須）
        ↓
      統合回答 → 知識保存 → concept mesh成長 → ヘッブ学習
        ↓
      未検証 → mystery登録 → investigate → 知識追加
        ↓
      間違い → feedback → 原因分析 → confidence/weight/rule修正
        ↓
      同じ質問 → キャッシュHIT or 修正済み知識 → 正しい即答
```

## Install

```bash
git clone https://github.com/mister-X-is-your-father/piece.git
cd piece
npm install
```

## Usage

```bash
# === Core ===
piece analyze <path>                  # コードベース分析（specialist自動生成）
piece analyze <path> --dry-run        # コスト見積もり
piece ask <path> "質問"               # 質問（知識DB→Manager→specialist→Fact Check）
piece specialists [path]              # specialist一覧
piece update <path>                   # 差分更新

# === Application Map ===
piece app-map <path>                  # 画面・API・操作・機能を自動検出
piece app-map <path> --screens        # 画面一覧
piece app-map <path> --endpoints      # API一覧
piece app-map <path> --features       # 機能一覧
piece app-map <path> --operations     # 操作一覧
piece app-map <path> --export         # Markdown出力

# === Knowledge Brain ===
piece investigate <path>              # 自律調査（謎を自動選択）
piece investigate <path> --loop 5     # 5サイクル連続調査
piece mysteries <path>                # 未解決の謎一覧
piece flows <path> --trace "フロー名"  # E2Eフロー追跡
piece knowledge <path>                # 知識統計
piece knowledge <path> --search "検索" # 知識検索
piece knowledge <path> --graph        # 接続グラフ

# === Feedback ===
piece feedback <path> --rating 2 --text "間違い内容"  # フィードバック送信
piece feedback <path> --list          # フィードバック履歴
piece feedback <path> --rules         # 学習ルール一覧
piece feedback <path> --stats         # 正答率推移

# === Obsidian Vault ===
piece vault export <path>             # 知識DB → Obsidian vault
piece vault import <path> <vault>     # Obsidian vault → 知識DB
piece vault sync <path>               # 双方向同期
piece reindex <path>                  # SQLite再構築（Markdownから）
```

## Backend

デフォルトで **Claude Code CLI** をバックエンドに使用。APIキー不要、定額課金(Max)プランで動作。

```bash
# デフォルト: Claude Code CLI（APIキー不要）
piece analyze .

# 直接API呼び出し（ANTHROPIC_API_KEY必要）
piece --backend api analyze .
```

## Tech Stack

- TypeScript (ESM)
- Claude Code CLI / Anthropic SDK
- better-sqlite3 (knowledge DB, 7 migrations)
- transformers.js (local embeddings, all-MiniLM-L6-v2)
- Commander (CLI)
- Zod (validation)
- gray-matter (frontmatter)

## License

MIT
