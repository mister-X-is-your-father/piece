# PIECE v2 — Python Architecture Design

次世代PIECEの設計書。TypeScript CLIから Python ハーネスへの進化。

---

## 1. 設計思想

### 1.1 PIECEとは何か

PIECEはハーネスである。フロントエンドではない。

```
ハーネス = エージェント制御 + 知識管理 + ファクトチェック + API提供
フロントエンド = UI（チャット、ダッシュボード、レビュー画面）

PIECEはハーネスだけを担当する。
フロントエンドはPIECEのAPIを叩くだけの別レイヤー。
```

### 1.2 3層分離（脳・手・セッション）

ハーネス仕様書の設計思想を採用。各層は独立して交換可能。

```
┌─────────────────────────────────────────────┐
│                   API Layer                  │
│            FastAPI (REST + SSE)              │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────┐  ┌─────────┐  ┌────────────┐  │
│  │  Brain   │  │  Hands  │  │  Session   │  │
│  │         │  │         │  │            │  │
│  │ Claude  │  │ Tools   │  │ PostgreSQL │  │
│  │ 呼び出し │  │ 実行    │  │ + pgvector │  │
│  │         │  │         │  │            │  │
│  │ Agent   │  │ Code    │  │ 会話履歴   │  │
│  │ SDK     │  │ Search  │  │ 知識DB     │  │
│  │         │  │ DB      │  │ 調査ログ   │  │
│  │ Routing │  │ AST     │  │ フィードバック│  │
│  │ 判断    │  │ Git     │  │ キャッシュ  │  │
│  └─────────┘  └─────────┘  └────────────┘  │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │         Agent Orchestration          │   │
│  │  Manager → Specialists → FactCheck   │   │
│  │         → Re-investigation loop      │   │
│  └──────────────────────────────────────┘   │
│                                             │
└─────────────────────────────────────────────┘
```

| 層 | 責務 | 技術 | 交換例 |
|---|---|---|---|
| Brain | Claude呼び出し、判断、ルーティング | Anthropic SDK + Agent SDK | モデル世代交代時にSDK更新のみ |
| Hands | ツール実行、コード検索、DB、AST解析 | tree-sitter, FAISS, MeCab | ツール追加・差替自由 |
| Session | 会話履歴、知識DB、調査ログ、フィードバック | PostgreSQL + pgvector | DB変更に非依存 |

### 1.3 SQLite → PostgreSQL

| | SQLite (v1) | PostgreSQL (v2) |
|---|---|---|
| ベクトル検索 | 自前LSH-ANN (95%リコール) | **pgvector HNSW (99%+リコール)** |
| 全文検索 | 自前N-gram + FTS5 | **pg_trgm + GIN index** |
| 並行アクセス | シングルライター | **マルチライター** |
| スケール | ファイルベース、1プロセス限定 | **複数サービスから同時接続** |
| API連携 | CLI内でしか使えない | **フロントエンド・他サービスから直接** |
| 日本語検索 | 自前bigram/trigram | **pg_bigm or PGroonga** |

Supabase（PostgreSQL + pgvector + Auth + Realtime）を使えば、インフラ管理も不要。

---

## 2. パッケージ構成

```
piece/
├── pyproject.toml              # uv / Poetry
├── alembic/                    # DBマイグレーション
│   └── versions/
│
├── piece/                      # メインパッケージ
│   ├── __init__.py
│   │
│   ├── brain/                  # 層1: AI判断
│   │   ├── __init__.py
│   │   ├── client.py           # Anthropic SDK ラッパー
│   │   ├── agent.py            # Agent SDK ベースのエージェント基盤
│   │   ├── manager.py          # オーケストレーター（質問ルーティング）
│   │   ├── specialist.py       # ドメインスペシャリスト
│   │   ├── fact_checker.py     # ファクトチェッカー（Opus）
│   │   ├── investigator.py     # 自律調査エージェント
│   │   ├── hearing.py          # ヒアリングエージェント（NEW）
│   │   ├── flow_tracer.py      # E2Eフロー追跡
│   │   └── prompts/            # システムプロンプト
│   │       ├── manager.py
│   │       ├── specialist.py
│   │       ├── fact_checker.py
│   │       ├── hearing.py
│   │       └── ...
│   │
│   ├── hands/                  # 層2: ツール実行
│   │   ├── __init__.py
│   │   ├── tools.py            # @tool デコレータ定義
│   │   ├── code_search.py      # コード検索（FAISS + tree-sitter）
│   │   ├── knowledge_search.py # 知識DB検索（6戦略）
│   │   ├── file_reader.py      # ソースコード読み込み
│   │   ├── ast_analyzer.py     # AST解析（tree-sitter）
│   │   ├── git_tools.py        # git log, diff, blame
│   │   ├── db_query.py         # DB直接クエリ
│   │   └── log_analyzer.py     # ログ解析
│   │
│   ├── session/                # 層3: 状態管理
│   │   ├── __init__.py
│   │   ├── database.py         # PostgreSQL接続 + SQLAlchemy
│   │   ├── models.py           # ORMモデル定義
│   │   ├── knowledge_store.py  # 知識CRUD + 検索
│   │   ├── mystery_store.py    # 未解決課題管理
│   │   ├── flow_store.py       # E2Eフロー管理
│   │   ├── feedback_store.py   # フィードバック + 学習ルール
│   │   ├── query_cache.py      # クエリキャッシュ
│   │   └── conversation.py     # 会話履歴管理（NEW）
│   │
│   ├── search/                 # 検索エンジン（Synapse v2）
│   │   ├── __init__.py
│   │   ├── engine.py           # 6戦略統合エンジン
│   │   ├── synapse.py          # 拡散活性化 + ヘッブ学習
│   │   ├── vector.py           # FAISS ベクトル検索
│   │   ├── structural.py       # ファイル・関数名検索
│   │   ├── temporal.py         # 時間ベース検索
│   │   ├── graph.py            # グラフウォーク（NetworkX）
│   │   ├── tag.py              # タグクラスタ
│   │   ├── concept_mesh.py     # 概念メッシュ（日英クロス）
│   │   └── tokenizer.py        # MeCab + 英語tokenizer
│   │
│   ├── analyzer/               # コード分析パイプライン
│   │   ├── __init__.py
│   │   ├── pipeline.py         # 分析オーケストレーション
│   │   ├── discovery.py        # ファイル探索
│   │   ├── parser.py           # AST解析（tree-sitter）
│   │   ├── dependency.py       # 依存グラフ構築
│   │   ├── clusterer.py        # スペシャリスト分割
│   │   └── app_detector.py     # 画面・API・機能検出
│   │
│   ├── api/                    # HTTP API層
│   │   ├── __init__.py
│   │   ├── app.py              # FastAPI アプリケーション
│   │   ├── routes/
│   │   │   ├── tickets.py      # 問い合わせCRUD
│   │   │   ├── messages.py     # ヒアリング対話
│   │   │   ├── review.py       # レビュー・承認
│   │   │   ├── knowledge.py    # 知識検索・管理
│   │   │   ├── specialists.py  # スペシャリスト管理
│   │   │   ├── analysis.py     # 分析実行
│   │   │   └── stream.py       # SSEストリーム
│   │   ├── deps.py             # 依存注入
│   │   └── schemas.py          # Pydantic リクエスト/レスポンス
│   │
│   ├── cli/                    # CLI（開発・デバッグ用）
│   │   ├── __init__.py
│   │   └── main.py             # Typer CLI
│   │
│   └── config/                 # 設定
│       ├── __init__.py
│       ├── settings.py         # Pydantic Settings
│       └── specialists.yaml    # スペシャリスト定義（YAML設定化）
│
├── tests/                      # テスト
│   ├── test_search.py          # 検索エンジンテスト（MRR/Recall@K）
│   ├── test_fact_check.py      # ファクトチェックテスト
│   ├── test_api.py             # APIテスト
│   └── e2e_benchmark.py        # 9軸厳格ベンチマーク
│
└── specialists/                # スペシャリスト定義ファイル（YAML）
    ├── _template.yaml
    └── ...（プロジェクトごとに生成）
```

---

## 3. 主要コンポーネント設計

### 3.1 Brain層: Agent SDKベースのエージェント

```python
# piece/brain/specialist.py
from anthropic.agent import Agent, tool

class SpecialistAgent:
    def __init__(self, config: SpecialistConfig):
        self.agent = Agent(
            model=config.model,
            system_prompt=config.system_prompt,
            tools=[
                self.search_knowledge,
                self.read_source_file,
                self.search_code,
                self.analyze_ast,
            ],
        )

    @tool
    def search_knowledge(self, query: str) -> list[KnowledgeNode]:
        """知識DBを6戦略で検索する"""
        return self.knowledge_store.search(query)

    @tool
    def read_source_file(self, path: str, start: int, end: int) -> str:
        """ソースコードの指定範囲を読む"""
        return self.file_reader.read(path, start, end)

    @tool
    def search_code(self, query: str) -> list[CodeResult]:
        """コードベースを検索する（AST + テキスト）"""
        return self.code_search.search(query)

    @tool
    def analyze_ast(self, path: str, symbol: str) -> ASTInfo:
        """関数・クラスの構造をAST解析する"""
        return self.ast_analyzer.analyze(path, symbol)

    async def investigate(self, question: str) -> SpecialistAnswer:
        result = await self.agent.run(question)
        return SpecialistAnswer(
            content=result.content,
            citations=result.tool_results,  # ツール呼び出し結果 = 根拠
            confidence=self.assess_confidence(result),
        )
```

**v1との違い:**
- ツールが宣言的。エージェントが「どのツールをいつ使うか」自分で判断
- プロンプトに全情報を詰め込む必要がない
- ツール結果がそのまま根拠（citation）になる

### 3.2 Hands層: ツール定義

```python
# piece/hands/code_search.py
import faiss
import tree_sitter

class CodeSearchTool:
    def __init__(self, index_path: str):
        self.faiss_index = faiss.read_index(index_path)
        self.parser = tree_sitter.Parser()

    def search(self, query: str, limit: int = 10) -> list[CodeResult]:
        # 1. ベクトル検索（FAISS HNSW）
        vector = self.embed(query)
        scores, indices = self.faiss_index.search(vector, limit)

        # 2. AST解析で関数・クラス境界を特定
        results = []
        for idx, score in zip(indices[0], scores[0]):
            chunk = self.chunks[idx]
            ast_context = self.get_ast_context(chunk.file, chunk.line)
            results.append(CodeResult(
                file=chunk.file,
                line=chunk.line,
                content=chunk.content,
                ast_context=ast_context,  # 関数名、クラス名、スコープ
                score=float(score),
            ))
        return results
```

**v1との違い:**
- FAISSのHNSW: 自前LSH(95%)→HNSW(99%+リコール、10倍速)
- tree-sitter AST: 文字列マッチング→構造的コード理解
- 関数・クラス単位でのチャンキング

### 3.3 Session層: PostgreSQL + pgvector

```python
# piece/session/models.py
from sqlalchemy import Column, String, Float, Integer, DateTime, ForeignKey
from pgvector.sqlalchemy import Vector

class KnowledgeNode(Base):
    __tablename__ = "knowledge_nodes"

    id = Column(String, primary_key=True)
    content = Column(String, nullable=False)
    summary = Column(String, nullable=False)
    node_type = Column(String, nullable=False)
    confidence = Column(Float, default=0.5)
    specialist = Column(String)
    embedding = Column(Vector(384))  # pgvectorで直接ベクトル格納
    access_count = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())

    # リレーション
    citations = relationship("NodeCitation", back_populates="node")
    tags = relationship("NodeTag", back_populates="node")
```

**v1との違い:**
- pgvector: ベクトル検索がSQLクエリ内で完結（`ORDER BY embedding <=> query_vector`）
- 自前のLSHバケットテーブルが不要
- インデックスもDB側（HNSW or IVFFlat）

### 3.4 ファクトチェッカー（Opus + AST検証）

```python
# piece/brain/fact_checker.py

class FactChecker:
    def __init__(self):
        self.agent = Agent(
            model="claude-opus-4-6",  # 最高精度モデルを使用
            system_prompt=FACT_CHECKER_SYSTEM,
            tools=[self.verify_code, self.check_ast],
        )

    @tool
    def verify_code(self, file: str, line: int, claim: str) -> Verification:
        """指定ファイルの指定行を読み、主張と照合する"""
        content = read_file_lines(file, line - 5, line + 5)
        exists = os.path.exists(file)
        line_valid = line <= count_lines(file) if exists else False
        return Verification(
            file_exists=exists,
            line_exists=line_valid,
            content=content,
        )

    @tool
    def check_ast(self, file: str, symbol: str) -> ASTVerification:
        """関数・クラスの存在と構造をAST解析で検証する"""
        tree = parse_file(file)
        node = find_symbol(tree, symbol)
        return ASTVerification(
            exists=node is not None,
            kind=node.type if node else None,
            start_line=node.start_point[0] if node else None,
            end_line=node.end_point[0] if node else None,
        )

    async def check(self, answer: str, root_path: str) -> FactCheckReport:
        # Opusがツールを使って自律的に検証する
        result = await self.agent.run(
            f"以下の回答を検証してください:\n{answer}"
        )
        return parse_report(result)
```

**v1との違い:**
- ファクトチェッカー自身がOpus（最高精度）
- AST検証ツール: 「この関数は存在するか」「この引数型は正しいか」を構造的に検証
- プログラム的検証とAI検証が統合（エージェントがツールとして両方使う）

### 3.5 確信度 → アクション（ハーネス仕様書から）

```python
# piece/brain/fact_checker.py

@dataclass
class VerifiedStatement:
    statement: str
    confidence: Confidence  # HIGH / MEDIUM / LOW
    source: Citation | None
    action: str  # エンジニアが何をすべきか

class Confidence(Enum):
    HIGH = "high"      # ドキュメント+コードで裏付け済み
    MEDIUM = "medium"  # コードに記載あるが実環境未確認
    LOW = "low"        # 推測ベース、裏付けなし

CONFIDENCE_ACTIONS = {
    Confidence.HIGH:   "そのまま信用してよい",
    Confidence.MEDIUM: "該当ファイルを開いて確認推奨",
    Confidence.LOW:    "この主張は未検証。独自調査が必要",
}
```

### 3.6 再調査ループ（ハーネス仕様書から）

```python
# piece/brain/manager.py

class Manager:
    MAX_INVESTIGATION_ROUNDS = 3

    async def handle_question(self, question: str) -> ManagerResult:
        for round in range(self.MAX_INVESTIGATION_ROUNDS):
            # 1. スペシャリストに調査依頼
            answers = await self.delegate_to_specialists(question)

            # 2. ファクトチェック
            fc_report = await self.fact_checker.check(answers)

            # 3. 確信度チェック
            low_confidence = [s for s in fc_report.statements
                              if s.confidence == Confidence.LOW]

            if len(low_confidence) <= 1:
                # 確信度十分 → 回答返却
                break

            # 4. 確信度不足 → 追加調査
            #    別のスペシャリスト or 同じスペシャリストに深堀り依頼
            question = self.refine_question(question, low_confidence)
            logger.info(f"Round {round+1}: {len(low_confidence)} low-confidence items, re-investigating")

        return self.synthesize(answers, fc_report)
```

**v1との違い:**
- 1回で終わらない。確信度が低ければ自動で再調査
- 最大3ラウンド。ラウンドごとに質問を精製

### 3.7 ヒアリングエージェント（NEW）

```python
# piece/brain/hearing.py

class HearingAgent:
    """問い合わせの情報不足を対話的に収集する"""

    MAX_QUESTIONS = 5

    REQUIRED_INFO = [
        "現象の具体的な説明",
        "再現手順",
        "環境情報",
        "エラーメッセージ",
    ]

    OPTIONAL_INFO = [
        "発生頻度",
        "直前の操作",
        "期待される動作",
    ]

    async def assess_completeness(self, inquiry: str) -> HearingResult:
        """情報の十分性を評価し、不足があれば質問を生成"""
        result = await self.agent.run(
            f"以下の問い合わせの情報十分性を評価:\n{inquiry}"
        )

        if result.is_sufficient:
            return HearingResult(ready=True, refined_question=result.refined)

        return HearingResult(
            ready=False,
            next_question=result.next_question,  # 選択肢提示型
            missing_info=result.missing,
        )
```

### 3.8 スペシャリストYAML設定

```yaml
# specialists/backend.yaml
name: バックエンド
description: APIエラー、データ不整合、バッチ処理の調査を担当
model: claude-sonnet-4-6
tools:
  - knowledge_search
  - code_search
  - read_source_file
  - analyze_ast
  - db_query
  - log_search
files:
  - src/api/**
  - src/services/**
  - src/models/**
keywords:
  - api
  - endpoint
  - database
  - transaction
  - migration
system_prompt: |
  あなたはバックエンド領域の専門家です。
  API、データベース、バッチ処理に関する深い知識を持っています。
  回答には必ず [source:path:L行番号] 形式で根拠を付けてください。
  不確実な情報は「未確認」と明示してください。
```

**v1との違い:**
- 自動生成ではなくYAML宣言的定義（手動編集可能）
- analyze時にYAMLを自動生成 → 人間が編集 → 以降はYAML優先
- ツールが明示的（このスペシャリストは何ができるか）

---

## 4. API設計

### 4.1 エンドポイント

```
# 問い合わせ
POST   /api/tickets                    # 新規問い合わせ作成
GET    /api/tickets                    # 一覧（ステータスフィルタ）
GET    /api/tickets/{id}               # 詳細取得
GET    /api/tickets/{id}/stream        # 調査進捗SSE

# ヒアリング対話
POST   /api/tickets/{id}/messages      # メッセージ送受信

# レビュー
GET    /api/tickets/{id}/review        # レビューデータ取得
POST   /api/tickets/{id}/review        # レビュー提出（承認/修正）
POST   /api/tickets/{id}/send          # 最終回答送信

# 知識
GET    /api/knowledge/search           # 知識検索
GET    /api/knowledge/stats            # 統計
GET    /api/knowledge/graph            # 知識グラフ

# スペシャリスト
GET    /api/specialists                # 一覧
CRUD   /api/specialists/{name}         # 管理

# 分析
POST   /api/analysis                   # 分析実行
GET    /api/analysis/{id}/status       # 分析進捗
```

### 4.2 ステータス遷移

```
receiving → hearing → investigating → fact_checking → review_pending → approved → sent
                                                          ↓
                                                    investigating（差し戻し）
```

### 4.3 SSEストリーム

```python
# piece/api/routes/stream.py

@router.get("/api/tickets/{id}/stream")
async def stream_progress(id: str):
    async def event_generator():
        async for event in ticket_service.watch(id):
            yield f"data: {event.json()}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

フロントエンドは `EventSource` で調査進捗をリアルタイム表示。

---

## 5. 検索エンジン v2（Synapse v2）

v1の6戦略を全てプロ仕様ライブラリで置き換える。

| # | 戦略 | v1 | v2 |
|---|------|----|----|
| 1 | ベクトル検索 | 自前LSH-ANN (SQLite BLOB) | **FAISS HNSW (pgvector)** |
| 2 | テキスト検索 | 自前N-gram + FTS5 | **MeCab形態素解析 + pg_trgm** |
| 3 | 概念展開 | 69手動エントリ + co-occurrence | **sentence-transformers類似度 + WordNet** |
| 4 | 拡散活性化 | 自前SQL | **NetworkX + 並列計算** |
| 5 | グラフウォーク | 自前SQL (1-2ホップ) | **NetworkX PageRank/Random Walk** |
| 6 | 構造検索 | LIKE '%term%' | **tree-sitter AST + シンボルテーブル** |

### 追加戦略（v2で新規）

| # | 戦略 | 説明 |
|---|------|------|
| 7 | **AST構造検索** | 関数シグネチャ、クラス継承、型情報で検索 |
| 8 | **Git履歴検索** | commit message + diff から「なぜこう変更したか」を検索 |
| 9 | **矛盾検出検索** | contradicts リンクを持つノードを優先表示 |

---

## 6. 技術スタック

| レイヤー | 技術 | 理由 |
|---------|------|------|
| 言語 | **Python 3.12+** | AIエコシステムの中心 |
| パッケージ管理 | **uv** | 高速、lockfile対応 |
| API | **FastAPI** | 型安全、async、OpenAPI自動生成 |
| AI SDK | **Anthropic SDK + Agent SDK** | 公式、ツール統合 |
| DB | **PostgreSQL + pgvector** | ベクトル検索内蔵、マルチ接続 |
| ORM | **SQLAlchemy 2.0** | 型安全、async対応 |
| マイグレーション | **Alembic** | SQLAlchemy標準 |
| ベクトル検索 | **FAISS** | Meta製、HNSW/IVF、本番実績 |
| 日本語処理 | **MeCab (fugashi)** | 形態素解析、N-gramより正確 |
| AST解析 | **tree-sitter** | 多言語対応、高速 |
| グラフ | **NetworkX** | 拡散活性化、PageRank |
| embedding | **sentence-transformers** | 多言語対応、本家 |
| CLI | **Typer** | 型安全、自動ヘルプ |
| テスト | **pytest + pytest-asyncio** | 標準 |
| 型チェック | **mypy** | 静的型検査 |
| Lint | **ruff** | 高速 |
| インフラ | **Supabase** (開発) / **AWS RDS** (本番) | pgvector対応 |

---

## 7. v1 → v2 移行マップ

### 残すもの（設計思想）

```
✅ 6戦略並行検索（道具をプロ仕様に交換するだけ）
✅ 拡散活性化 + ヘッブ学習（NetworkXで高速化）
✅ 概念メッシュ（日英クロス言語）
✅ ファクトチェック2段階（プログラム的→AI）
✅ 適応的戦略重み（フィードバックから学習）
✅ MMR結果多様化
✅ MECE Matrix（網羅性保証）
✅ Mystery自動検出（知識の穴を埋める）
✅ 9軸厳格ベンチマーク（採点基準は同一）
✅ 自律改善サイクル（VISION.md/CHANGELOG.md/ISSUES.md）
```

### 捨てるもの（TypeScript実装の制約）

```
❌ claude CLI spawn → Agent SDK直接呼び出し
❌ 自前LSH-ANN → FAISS HNSW
❌ 自前N-gram tokenizer → MeCab形態素解析
❌ better-sqlite3 同期DB → PostgreSQL async
❌ CLI-only → FastAPI + CLI
❌ 自前agent-runner → Agent SDK
❌ 文字列ベースのコード解析 → tree-sitter AST
```

### 新しく追加するもの（ハーネス仕様書から）

```
🆕 ヒアリングエージェント（情報不足の対話的収集）
🆕 確信度 → アクション紐付け（高/中/低 → 何をすべきか）
🆕 再調査ループ（確信度低 → 自動追加調査、最大3ラウンド）
🆕 YAML設定化スペシャリスト（宣言的定義、手動編集可能）
🆕 ステータス遷移（receiving→hearing→investigating→...→sent）
🆕 SSEストリーム（調査進捗のリアルタイム配信）
🆕 AST構造検索（関数シグネチャ、型情報で検索）
🆕 レビューAPI（エンジニア承認フロー）
```

---

## 8. 実装ロードマップ

### Phase 1: 基盤（2週間）

```
- pyproject.toml + uv セットアップ
- PostgreSQL + pgvector + Alembic マイグレーション
- SQLAlchemy モデル定義（v1のテーブルを移植）
- Anthropic SDK + Agent SDK 接続
- 基本的なSpecialistAgent（ツールなし、プロンプトのみ）
- pytest 基盤
```

### Phase 2: 検索エンジン v2（2週間）

```
- FAISS HNSW ベクトル検索
- MeCab 日本語トークナイザー
- sentence-transformers embedding
- pg_trgm テキスト検索
- NetworkX 拡散活性化 + ヘッブ学習
- 6戦略統合エンジン
- 検索テスト（MRR/Recall@K、v1と同一テストケース）
```

### Phase 3: エージェントシステム（2週間）

```
- Manager（ルーティング + 再調査ループ）
- Specialist（Agent SDK + ツール）
- FactChecker（Opus + AST検証）
- tree-sitter AST解析ツール
- ヒアリングエージェント
- YAML設定化スペシャリスト
```

### Phase 4: API + 分析（2週間）

```
- FastAPI アプリケーション
- 全エンドポイント実装
- SSEストリーム
- 分析パイプライン（tree-sitter版）
- 9軸ベンチマーク（Python版、同一採点基準）
```

### Phase 5: 統合テスト + 移行（1週間）

```
- TypeORM ベンチマーク（v1と同一15問で比較）
- v1 → v2 スコア比較
- v1の知識DBをv2にマイグレーション
- ドキュメント更新
```

---

## 9. この設計で解決されるv1の課題

| ISSUE | v1の問題 | v2での解決 |
|-------|---------|-----------|
| 001 | ファクトチェック0件 | Opus + ツール自律検証。citation形式の不一致は構造的に解消 |
| 002 | ファイルヒット率28% | tree-sitter AST検索。ファイル・関数を構造的に特定 |
| 003 | 回答の実質性低下 | Agent SDKのツール結果が根拠に直結。プロンプト芸からの脱却 |
| 004 | フロー追跡不足 | 再調査ループで確信度低のフローを深堀り |
| 005 | 検索スケーラビリティ | FAISS HNSW + pgvector。50K→数百万ノード対応 |
| 006 | ベンチマーク速度 | Agent SDK直接呼び出し。CLIサブプロセスspawnの廃止 |
| 007 | Agent Runner全滅 | Agent SDK の組み込みエラーハンドリング |
| 008 | CLI max-turns制限 | Agent SDK にmax-turns制限なし |
| 009 | Rate Limit全滅 | Agent SDK の組み込みバックオフ + async並行制御 |

---

## 10. RPA層設計

### 10.1 全体像: 4層アーキテクチャ

RPA層を加えると、システムは4層になる。

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend Layer                         │
│              Next.js（チャット + ダッシュボード）           │
├──────────────────────────────────────────────────────────┤
│                    Harness Layer (PIECE)                  │
│      Brain + Hands + Session（判断・知識・ファクトチェック）  │
├──────────────────────────────────────────────────────────┤
│                    RPA Layer                              │
│     ブラウザ操作 + ログ収集 + 動作検証 + スクリーンショット   │
├──────────────────────────────────────────────────────────┤
│                    Target Systems                         │
│          顧客のアプリ / DB / サーバー / ログ基盤            │
└──────────────────────────────────────────────────────────┘
```

**各層の境界を明確にする:**

| 層 | やること | やらないこと |
|---|---|---|
| Frontend | UI表示、ユーザー入力 | 判断、ツール実行 |
| Harness (PIECE) | 判断、知識検索、ファクトチェック、回答生成 | ブラウザ操作、外部ログ取得 |
| RPA | ブラウザ操作、ログ収集、動作検証、スクショ | 判断、回答生成、知識管理 |
| Target | 顧客のシステム（操作される側） | — |

### 10.2 根本的な問い: ログ確認はどっちがやるべきか

```
パターンA: RPA層でログ収集→PIECEに渡す
  RPA: SSH接続 → tail -f /var/log/app.log → フィルタ → PIECEに返す
  PIECE: ログを受け取って分析・回答に反映

パターンB: PIECE（Hands層）が直接ログDBを叩く
  PIECE: SELECT * FROM logs WHERE level='ERROR' AND timestamp > now()-1h
  ログ基盤(Datadog等)のAPIを直接叩く

パターンC: ハイブリッド
  構造化ログ（DB、Datadog等） → PIECE Hands層が直接アクセス
  非構造化ログ（ファイル、コンソール出力） → RPA層が収集してPIECEに渡す
```

**結論: パターンC（ハイブリッド）を採用する。**

理由:
```
構造化ログ（DB/API）:
  → クエリで取れる → APIコール1回 → PIECEのHands層で十分
  → RPAを挟む意味がない（遅くなるだけ）
  → 例: Datadog API, CloudWatch, Supabase logs

非構造化ログ（ファイル/SSH/コンソール）:
  → サーバーにSSH接続してtail → パース → フィルタ
  → これはRPAの仕事（外部システムへの物理的アクセス）
  → 例: /var/log/nginx/error.log, Docker logs, PM2 logs

ブラウザのDevToolsログ:
  → ブラウザを操作しないと取れない → RPA
  → Network tab, Console errors, Performance
```

### 10.3 RPA層のアーキテクチャ

```
piece/
├── piece/                      # ハーネス（既存）
│   ├── brain/
│   ├── hands/
│   │   ├── tools.py
│   │   ├── log_query.py        # 構造化ログ（DB/API直接）
│   │   └── rpa_client.py       # RPA層への依頼インターフェース ★
│   └── session/
│
└── rpa/                        # RPA層（独立サービス）
    ├── pyproject.toml
    ├── rpa/
    │   ├── __init__.py
    │   ├── server.py           # FastAPI（PIECE→RPAの通信口）
    │   │
    │   ├── browser/            # ブラウザ操作
    │   │   ├── __init__.py
    │   │   ├── engine.py       # Playwright制御エンジン
    │   │   ├── actions.py      # 操作アクション定義
    │   │   ├── capture.py      # スクリーンショット・録画
    │   │   └── devtools.py     # DevToolsログ収集
    │   │
    │   ├── logs/               # 非構造化ログ収集
    │   │   ├── __init__.py
    │   │   ├── ssh_collector.py    # SSH経由のログ取得
    │   │   ├── docker_collector.py # Docker logs
    │   │   ├── file_collector.py   # ローカルファイル
    │   │   └── parser.py           # ログパース・正規化
    │   │
    │   ├── verify/             # 動作検証
    │   │   ├── __init__.py
    │   │   ├── scenario.py     # 検証シナリオ定義
    │   │   ├── runner.py       # シナリオ実行エンジン
    │   │   ├── assertion.py    # 期待値チェック
    │   │   └── report.py       # 検証レポート生成
    │   │
    │   ├── config/             # RPA設定
    │   │   ├── targets.yaml    # 対象システム定義
    │   │   └── credentials.py  # 認証情報管理（Vault連携）
    │   │
    │   └── models.py           # Pydantic スキーマ
    │
    └── tests/
```

### 10.4 PIECE ↔ RPA 通信設計

**RPA層は独立サービスとして動く。PIECEとはHTTP APIで通信する。**

なぜプロセス内に組み込まないか:
```
1. Playwrightのブラウザプロセスは重い（メモリ、CPU）
   → PIECEのエージェント処理に影響を与えたくない

2. RPAは対象システムのネットワーク内にいる必要がある場合がある
   → PIECEと別マシンで動くかもしれない

3. RPAだけスケールしたい場合がある
   → 複数ブラウザで並列検証
```

#### 通信インターフェース

```
PIECE → RPA:
  POST /rpa/browser/execute     ブラウザ操作の実行
  POST /rpa/logs/collect        ログ収集の実行
  POST /rpa/verify/run          動作検証の実行
  GET  /rpa/jobs/{id}/status    ジョブの進捗確認
  GET  /rpa/jobs/{id}/result    ジョブの結果取得

RPA → PIECE:
  POST /api/tickets/{id}/evidence   証拠データの送信（コールバック）
```

#### PIECE Hands層からの呼び出し

```python
# piece/hands/rpa_client.py

class RPAClient:
    """PIECE→RPA通信クライアント。Agent SDKのツールとして使える。"""

    def __init__(self, rpa_url: str):
        self.base_url = rpa_url
        self.client = httpx.AsyncClient()

    async def execute_browser_action(
        self, action: BrowserAction
    ) -> BrowserResult:
        """ブラウザ操作を実行し結果を待つ"""
        resp = await self.client.post(
            f"{self.base_url}/rpa/browser/execute",
            json=action.dict(),
        )
        job = resp.json()
        return await self._wait_for_result(job["id"])

    async def collect_logs(
        self, target: str, query: LogQuery
    ) -> LogCollection:
        """非構造化ログを収集する"""
        resp = await self.client.post(
            f"{self.base_url}/rpa/logs/collect",
            json={"target": target, "query": query.dict()},
        )
        job = resp.json()
        return await self._wait_for_result(job["id"])

    async def verify_scenario(
        self, scenario: VerificationScenario
    ) -> VerificationReport:
        """動作検証シナリオを実行する"""
        resp = await self.client.post(
            f"{self.base_url}/rpa/verify/run",
            json=scenario.dict(),
        )
        job = resp.json()
        return await self._wait_for_result(job["id"])
```

#### PIECE Specialist がRPAを使う例

```python
# piece/brain/specialist.py

class SpecialistAgent:
    @tool
    async def reproduce_issue(
        self, url: str, steps: list[str]
    ) -> ReproductionResult:
        """顧客の報告を実際にブラウザで再現する"""
        action = BrowserAction(
            target_url=url,
            steps=[BrowserStep(action=s) for s in steps],
            capture_screenshot=True,
            capture_console=True,
            capture_network=True,
        )
        return await self.rpa_client.execute_browser_action(action)

    @tool
    async def check_server_logs(
        self, target: str, time_range: str, level: str
    ) -> LogCollection:
        """サーバーログを確認する（非構造化ログ）"""
        query = LogQuery(
            time_range=time_range,
            level=level,
            limit=100,
        )
        return await self.rpa_client.collect_logs(target, query)

    @tool
    async def query_log_db(
        self, sql: str
    ) -> list[dict]:
        """構造化ログをDBから直接取得する（RPA不要）"""
        # これはHands層の直接ツール。RPAを経由しない
        return await self.log_db.execute(sql)
```

### 10.5 ログ確認の判断フロー

PIECEのBrain層が「どの手段でログを取るか」を自律判断する:

```
質問: 「エラーが出る」

Brain (Manager):
  1. 構造化ログがあるか？
     → Datadog/CloudWatch/ログDB → Hands層で直接クエリ（高速）

  2. 非構造化ログが必要か？
     → サーバーファイル/Docker/PM2 → RPA層に依頼（SSH接続）

  3. ブラウザログが必要か？
     → DevTools Console/Network → RPA層に依頼（Playwright）

  4. 再現が必要か？
     → ブラウザで操作を再現 → RPA層に依頼（操作+キャプチャ）
```

```python
# piece/brain/manager.py での判断ロジック

class Manager:
    async def investigate_with_evidence(self, question: str, ticket: Ticket):
        # スペシャリストの調査結果
        answers = await self.delegate_to_specialists(question)

        # 確信度チェック
        fc = await self.fact_checker.check(answers)

        low_conf = [s for s in fc.statements if s.confidence == Confidence.LOW]

        if low_conf:
            # 確信度低 → 追加証拠が必要
            evidence_plan = await self.plan_evidence_gathering(low_conf, ticket)

            for task in evidence_plan:
                match task.type:
                    case "log_query":
                        # 構造化ログ → Hands直接
                        result = await self.hands.query_log_db(task.query)
                    case "log_collect":
                        # 非構造化ログ → RPA
                        result = await self.hands.rpa.collect_logs(task.target, task.query)
                    case "reproduce":
                        # ブラウザ再現 → RPA
                        result = await self.hands.rpa.reproduce_issue(task.url, task.steps)
                    case "verify":
                        # 動作検証 → RPA
                        result = await self.hands.rpa.verify_scenario(task.scenario)

                # 証拠をticketに添付
                await self.session.add_evidence(ticket.id, result)

            # 証拠を踏まえて再回答
            answers = await self.delegate_to_specialists(
                question,
                additional_context=evidence_plan.results,
            )
```

### 10.6 RPA層の内部設計

#### ブラウザエンジン

```python
# rpa/browser/engine.py

class BrowserEngine:
    """Playwright ベースのブラウザ自動操作エンジン"""

    async def execute(self, action: BrowserAction) -> BrowserResult:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                record_video_dir="/tmp/rpa_videos" if action.record_video else None,
            )
            page = await context.new_page()

            # DevToolsログ収集開始
            console_logs = []
            network_logs = []
            if action.capture_console:
                page.on("console", lambda msg: console_logs.append(msg))
            if action.capture_network:
                page.on("response", lambda resp: network_logs.append(resp))

            # ステップ実行
            results = []
            for step in action.steps:
                result = await self._execute_step(page, step)
                results.append(result)

                if action.capture_screenshot:
                    screenshot = await page.screenshot()
                    result.screenshot = screenshot

            await browser.close()

            return BrowserResult(
                steps=results,
                console_logs=console_logs,
                network_logs=network_logs,
                success=all(r.success for r in results),
            )

    async def _execute_step(self, page, step: BrowserStep) -> StepResult:
        match step.action:
            case "navigate":
                await page.goto(step.url)
            case "click":
                await page.click(step.selector)
            case "fill":
                await page.fill(step.selector, step.value)
            case "wait":
                await page.wait_for_selector(step.selector)
            case "assert_visible":
                visible = await page.is_visible(step.selector)
                return StepResult(success=visible, detail=f"visible={visible}")
            case "assert_text":
                text = await page.text_content(step.selector)
                match = step.expected in text if text else False
                return StepResult(success=match, detail=f"text={text}")
        return StepResult(success=True)
```

#### ログ収集

```python
# rpa/logs/ssh_collector.py

class SSHLogCollector:
    """SSH経由で非構造化ログを収集"""

    async def collect(self, target: SSHTarget, query: LogQuery) -> LogCollection:
        async with asyncssh.connect(
            target.host, username=target.user, client_keys=[target.key]
        ) as conn:
            # ログファイルをフィルタリングして取得
            cmd = self._build_command(query)
            result = await conn.run(cmd)

            # パースして正規化
            entries = self.parser.parse(result.stdout, query.format)

            return LogCollection(
                source=f"ssh://{target.host}{query.path}",
                entries=entries,
                total=len(entries),
                time_range=query.time_range,
            )

    def _build_command(self, query: LogQuery) -> str:
        """ログ取得コマンドを構築"""
        parts = [f"tail -n {query.limit} {query.path}"]
        if query.level:
            parts.append(f"| grep -i '{query.level}'")
        if query.keyword:
            parts.append(f"| grep '{query.keyword}'")
        if query.time_range:
            parts.append(f"| awk '$0 >= \"{query.since}\"'")
        return " ".join(parts)
```

#### 動作検証

```python
# rpa/verify/runner.py

class VerificationRunner:
    """修正後の動作を自動検証する"""

    async def run(self, scenario: VerificationScenario) -> VerificationReport:
        engine = BrowserEngine()

        results = []
        for case in scenario.test_cases:
            # 前提条件セットアップ
            if case.setup:
                await engine.execute(case.setup)

            # テスト操作実行
            result = await engine.execute(case.action)

            # アサーション
            assertions = []
            for assertion in case.assertions:
                passed = self._check_assertion(assertion, result)
                assertions.append(AssertionResult(
                    description=assertion.description,
                    passed=passed,
                    actual=result.get_value(assertion.target),
                    expected=assertion.expected,
                ))

            results.append(TestCaseResult(
                name=case.name,
                passed=all(a.passed for a in assertions),
                assertions=assertions,
                screenshot=result.steps[-1].screenshot if result.steps else None,
            ))

        return VerificationReport(
            scenario=scenario.name,
            passed=all(r.passed for r in results),
            results=results,
            summary=self._summarize(results),
        )
```

### 10.7 対象システム定義（YAML）

```yaml
# rpa/config/targets.yaml

targets:
  production:
    name: 本番環境
    base_url: https://app.example.com
    auth:
      type: cookie
      login_url: /login
      credentials_ref: vault://prod/admin  # Vault参照
    logs:
      structured:
        type: datadog
        api_key_ref: vault://datadog/api_key
        service: app-backend
      unstructured:
        - type: ssh
          host: app-server-1
          user: deploy
          key_ref: vault://ssh/deploy_key
          paths:
            - /var/log/app/error.log
            - /var/log/nginx/access.log
        - type: docker
          container: app-backend
          compose_file: /opt/app/docker-compose.yml

  staging:
    name: ステージング環境
    base_url: https://staging.example.com
    auth:
      type: basic
      credentials_ref: vault://staging/admin
    logs:
      structured:
        type: supabase
        project_ref: xxxx
        api_key_ref: vault://supabase/service_key
```

### 10.8 セキュリティ設計

```
認証情報:
  → 全てVault（HashiCorp Vault or AWS Secrets Manager）経由
  → RPA層は認証情報を永続化しない
  → 実行時にVaultから取得、メモリ上のみ

ネットワーク:
  → RPA層は対象システムのネットワーク内に配置
  → PIECE → RPA は mTLS で暗号化
  → RPA → Target はtargetの認証方式に従う

権限:
  → RPA層はread-onlyが原則（ログ収集、画面確認のみ）
  → 書き込み操作（フォーム入力等）はscenario定義でホワイトリスト
  → 本番環境への書き込みは承認フラグ必須
```

### 10.9 PIECEのログ分析との関係

PIECEには既に `log-analyzer` がある（v1のsrc/knowledge/log-analyzer.ts）。
これとRPA層のログ収集の関係:

```
RPA層: ログを「集める」（SSH、Docker、DevTools）
  ↓ 生ログデータ
PIECE Hands層: ログを「解析する」（パターン検出、タイムライン、異常検知）
  ↓ 解析結果
PIECE Brain層: ログ解析結果を「判断に使う」（原因特定、回答生成）
```

つまり:
- **収集** = RPA層（物理的アクセス）
- **解析** = PIECE Hands層（log-analyzer のPython版）
- **判断** = PIECE Brain層（エージェントの推論）

```python
# piece/hands/log_analyzer.py（PIECE側）

class LogAnalyzer:
    """収集されたログを解析する（パターン検出、タイムライン、異常検知）"""

    async def analyze(self, logs: LogCollection) -> LogAnalysis:
        # 1. エラーパターン検出
        patterns = self.detect_patterns(logs.entries)

        # 2. タイムライン構築
        timeline = self.build_timeline(logs.entries)

        # 3. 異常検知
        anomalies = self.detect_anomalies(logs.entries)

        # 4. 相関分析（複数ログソース間）
        correlations = self.find_correlations(logs.entries)

        return LogAnalysis(
            patterns=patterns,
            timeline=timeline,
            anomalies=anomalies,
            correlations=correlations,
            summary=self.summarize(patterns, anomalies),
        )
```

### 10.10 デプロイ構成

```
┌─ Cloud / On-premises ──────────────────────────────┐
│                                                     │
│  ┌─ PIECE Harness ─────┐  ┌─ RPA Service ────────┐ │
│  │ FastAPI              │  │ FastAPI               │ │
│  │ Brain + Hands        │  │ Playwright            │ │
│  │ Session (PostgreSQL) │←→│ SSH / Docker clients  │ │
│  │                      │  │                       │ │
│  │ :8000               │  │ :8100                 │ │
│  └──────────────────────┘  └───────────────────────┘ │
│         ↑                          ↑                  │
│         │ API                      │ Target access    │
│  ┌──────┴──────┐           ┌───────┴──────────┐      │
│  │  Frontend   │           │  Target Systems  │      │
│  │  Next.js    │           │  App / DB / Logs  │      │
│  │  :3000      │           │                   │      │
│  └─────────────┘           └──────────────────┘      │
└──────────────────────────────────────────────────────┘

通信:
  Frontend → PIECE:  HTTPS (REST + SSE)
  PIECE → RPA:       HTTPS (mTLS)
  RPA → Targets:     SSH / HTTPS / Docker API
```

### 10.11 RPA層を使った調査フロー全体像

```
顧客:「ログインできない」
  ↓
① Frontend → PIECE API: POST /api/tickets
  ↓
② PIECE ヒアリング:「ブラウザは何ですか？エラーメッセージは出ましたか？」
  ↓（顧客回答: Chrome、「Invalid credentials」と表示）
  ↓
③ PIECE Manager → Specialist(バックエンド):「認証エラーを調査」
  ↓
④ Specialist判断: 「ログとブラウザ再現が必要」
  ↓
⑤-a PIECE → Hands(直接): SELECT * FROM auth_logs WHERE status='failed' ORDER BY created_at DESC LIMIT 10
    → 結果: 「このユーザーのログイン試行は記録されていない」
  ↓
⑤-b PIECE → RPA: 「このURL+認証情報でログインを試行して」
    → RPA: Playwright実行 → スクリーンショット + NetworkログCapture
    → 結果: 「403 Forbidden, APIが /api/v2/auth を返している、レスポンスbody: {"error":"account_locked"}」
  ↓
⑤-c PIECE → RPA: 「サーバーログの過去1時間のauth関連エラーを取得して」
    → RPA: SSH → grep 'auth' /var/log/app/error.log
    → 結果: 「Account locked after 5 failed attempts (IP: 203.0.113.1)」
  ↓
⑥ Specialist統合: 「アカウントがロックされている。5回の失敗試行後にロック。ログインではなくアカウントロック解除が必要」
  ↓
⑦ PIECE FactCheck(Opus):
    - ✅ HIGH: auth_logsにログイン記録なし（DBクエリ結果で確認）
    - ✅ HIGH: APIが account_locked を返している（RPA Networkログで確認）
    - ✅ HIGH: 5回失敗でロック（サーバーログで確認）
  ↓
⑧ PIECE → 回答ドラフト:
    「お客様のアカウントは、5回のログイン失敗によりロックされています。
     管理画面からロックを解除してください。
     [証拠: ログ、APIレスポンス、スクリーンショット添付]」
  ↓
⑨ エンジニアレビュー: 確信度HIGH×3 → サッと確認 → 承認
  ↓
⑩ 顧客に送信
```
