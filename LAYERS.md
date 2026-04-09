# PIECE v2 — Layer Architecture（層構造設計）

全設計を統合し、依存方向を厳密に制御する。
独立性・テスト容易性・拡張性・再利用性を最大化するための設計。

---

## 1. 設計原則

### 1.1 依存は内側にしか向かない

```
    Layer 4: Entry Points（HTTP, CLI, Cron）
        ↓ depends on
    Layer 3: Adapters（技術固有の実装）
        ↓ depends on
    Layer 2: Ports（抽象インターフェース）
        ↓ depends on
    Layer 1: Use Cases（アプリケーションロジック）
        ↓ depends on
    Layer 0: Core Domain（純粋なドメインロジック）

    ✅ 外側 → 内側: 常に許可
    ❌ 内側 → 外側: 絶対禁止
    ❌ 同層間の依存: 禁止（Port経由で疎結合にする）
```

**Layer 0はimport文がゼロ。** 外部ライブラリも他の層も一切参照しない。
テストはモック不要。純粋関数のユニットテストだけで100%カバー可能。

### 1.2 5つの品質特性

```
独立性:     各層は他の層の内部を知らない。Portだけを知る
テスト容易性: 各層を単独でテスト可能。モックはPort境界のみ
拡張性:     新しいAdapter追加 = 新ファイル追加のみ。既存コード変更ゼロ
再利用性:   Layer 0-1 は技術非依存。別プロジェクトにそのまま持っていける
交換性:     PostgreSQL → MongoDB、Anthropic → OpenAI、Playwright → Puppeteer
            = Adapter差し替えのみ。Use CaseもCoreも一切変更不要
```

---

## 2. Layer 0: Core Domain（純粋ドメイン）

**外部依存ゼロ。** Python標準ライブラリのみ使用。
ビジネスルールとドメインロジックの核心。

```
piece/core/
├── __init__.py
│
├── types/                      # 全層が共有する型定義
│   ├── __init__.py
│   ├── evidence.py             # Evidence, EvidenceBundle, Confidence
│   ├── knowledge.py            # KnowledgeNode, NodeLink, Citation
│   ├── ticket.py               # Ticket, TicketStatus, Message
│   ├── investigation.py        # Investigation, FactCheck, Verdict
│   ├── response.py             # ResponseDraft, FinalResponse, ReviewPoint
│   ├── frontier.py             # KnowledgeFrontier, DanglingRef, LogicGap
│   ├── specialist.py           # SpecialistConfig, ExplorationTask
│   └── common.py               # ID, Timestamp, Result[T, E]
│
├── rules/                      # ビジネスルール（純粋関数）
│   ├── __init__.py
│   ├── confidence.py           # 確信度の計算・集約ルール
│   ├── priority.py             # 優先度の計算ルール
│   ├── sla.py                  # SLA違反判定ルール
│   ├── routing.py              # 質問→スペシャリスト振り分けルール
│   ├── scoring.py              # ベンチマーク採点ルール
│   └── safety.py               # 安全性判定ルール（操作レベル判定）
│
├── gates/                      # 回答品質ゲート（純粋ロジック）
│   ├── __init__.py
│   ├── base.py                 # Gate ABC, GateResult
│   ├── factuality.py           # 事実性チェックロジック
│   ├── completeness.py         # 完全性チェックロジック
│   ├── honesty.py              # 誠実性チェックロジック
│   ├── readability.py          # 可読性チェックロジック
│   ├── actionability.py        # 行動可能性チェックロジック
│   └── security.py             # セキュリティチェックロジック
│
├── search/                     # 検索戦略（純粋アルゴリズム）
│   ├── __init__.py
│   ├── strategy.py             # SearchStrategy ABC
│   ├── synapse.py              # 拡散活性化アルゴリズム（データ構造のみ）
│   ├── hebbian.py              # ヘッブ学習ルール
│   ├── concept_mesh.py         # 概念メッシュ操作
│   ├── mmr.py                  # MMR多様化アルゴリズム
│   └── scoring.py              # スコア集約・重み計算
│
└── frontier/                   # 好奇心探索（純粋ロジック）
    ├── __init__.py
    ├── scanner.py              # Frontier検出ロジック
    ├── planner.py              # 探索優先度計算
    └── false_known.py          # False Known検出ルール
```

### Layer 0 の鉄則

```python
# ❌ 禁止: Layer 0 内での外部import
import sqlalchemy          # ❌ DBライブラリ
import anthropic           # ❌ AI SDK
import httpx               # ❌ HTTPクライアント
import faiss               # ❌ 検索ライブラリ

# ✅ 許可: Python標準ライブラリのみ
from dataclasses import dataclass
from abc import ABC, abstractmethod
from enum import Enum
from typing import Protocol, TypeVar, Generic
from datetime import datetime
import re
import math
```

### Layer 0 のテスト

```python
# モック不要。純粋関数のテスト。

def test_confidence_aggregation():
    """確信度の集約ルール"""
    evidences = [
        Evidence(confidence=Confidence.HIGH, ...),
        Evidence(confidence=Confidence.MEDIUM, ...),
        Evidence(confidence=Confidence.HIGH, ...),
    ]
    assert aggregate_confidence(evidences) == Confidence.HIGH

def test_sla_violation():
    """SLA違反判定"""
    ticket = Ticket(status="review_pending", review_requested_at=hours_ago(5))
    violations = check_sla(ticket, SLAConfig(review_timeout_hours=4))
    assert len(violations) == 1
    assert violations[0].type == "review_escalation"

def test_false_known_detection():
    """False Known検出"""
    node = KnowledgeNode(confidence=0.9, content="おそらくこの関数は...")
    suspects = detect_false_known_signals(node)
    assert any(s.signal == "speculative" for s in suspects)
```

---

## 3. Layer 1: Use Cases（アプリケーションロジック）

**Port（抽象インターフェース）のみに依存。** 具体的な技術は知らない。
「何をするか」を記述し、「どうやるか」はPortに委譲する。

```
piece/usecases/
├── __init__.py
│
├── ask.py                      # 質問→回答フロー
├── investigate.py              # 自律調査フロー
├── analyze.py                  # コードベース分析フロー
├── respond.py                  # 回答生成パイプライン（8ゲート）
├── review.py                   # エンジニアレビューフロー
├── hearing.py                  # ヒアリングフロー
├── curiosity.py                # 好奇心探索ループ
├── feedback.py                 # フィードバック学習フロー
├── evidence.py                 # 証拠収集オーケストレーション
└── notify.py                   # 通知フロー
```

### Use Caseの例

```python
# piece/usecases/ask.py

class AskUseCase:
    """質問に回答するユースケース"""

    def __init__(
        self,
        knowledge_port: KnowledgePort,        # 知識の読み書き
        ai_port: AIPort,                       # AI呼び出し
        search_port: SearchPort,               # 検索
        fact_check_port: FactCheckPort,        # ファクトチェック
        response_port: ResponsePort,           # 回答生成
        notification_port: NotificationPort,   # 通知
    ):
        # Portのみに依存。具体的な技術は一切知らない
        self.knowledge = knowledge_port
        self.ai = ai_port
        self.search = search_port
        self.fact_check = fact_check_port
        self.response = response_port
        self.notification = notification_port

    async def execute(self, question: str, ticket_id: str) -> FinalResponse:
        # 1. キャッシュ確認
        cached = await self.knowledge.find_cached_answer(question)
        if cached:
            return cached

        # 2. 知識DB検索
        relevant = await self.search.multi_strategy_search(question)
        if self._is_sufficient(relevant):
            return await self.response.from_knowledge(relevant)

        # 3. スペシャリスト調査
        routing = route_to_specialists(question, await self.knowledge.get_specialists())
        investigations = []
        for assignment in routing:
            result = await self.ai.ask_specialist(assignment)
            investigations.append(result)

        # 4. ファクトチェック
        fact_checks = []
        for inv in investigations:
            fc = await self.fact_check.verify(inv)
            fact_checks.append(fc)

        # 5. 確信度低 → 再調査ループ
        for round in range(MAX_ROUNDS):
            low_conf = [fc for fc in fact_checks if fc.confidence == Confidence.LOW]
            if len(low_conf) <= 1:
                break
            # 追加調査
            additional = await self._reinvestigate(question, low_conf)
            investigations.extend(additional)

        # 6. 回答生成（8ゲート）
        response = await self.response.generate(
            question, investigations, fact_checks,
        )

        # 7. 知識保存
        await self.knowledge.save_from_response(question, response)

        return response
```

### テスト: Portをモックするだけ

```python
async def test_ask_returns_cached():
    """キャッシュヒット時はAIを呼ばない"""
    knowledge = MockKnowledgePort(cached_answer=some_response)
    ai = MockAIPort()  # 呼ばれないはず

    usecase = AskUseCase(knowledge=knowledge, ai=ai, ...)
    result = await usecase.execute("test question", "ticket-1")

    assert result == some_response
    assert ai.call_count == 0  # AIは呼ばれていない

async def test_ask_reinvestigates_on_low_confidence():
    """確信度低が多い場合、再調査する"""
    fact_check = MockFactCheckPort(results=[
        FactCheck(confidence=Confidence.LOW),
        FactCheck(confidence=Confidence.LOW),
        FactCheck(confidence=Confidence.LOW),
    ])
    ai = MockAIPort()

    usecase = AskUseCase(fact_check=fact_check, ai=ai, ...)
    await usecase.execute("test", "ticket-1")

    assert ai.specialist_call_count >= 2  # 再調査が走った
```

---

## 4. Layer 2: Ports（抽象インターフェース）

**技術を知らない境界。** Layer 1が使う「契約」だけを定義する。
実装はLayer 3のAdapterが担当。

```
piece/ports/
├── __init__.py
│
├── ai.py                       # AI呼び出し
├── knowledge.py                # 知識の読み書き
├── search.py                   # 検索
├── fact_check.py               # ファクトチェック
├── response.py                 # 回答生成
├── collector.py                # 証拠収集
├── prober.py                   # 能動検査
├── verifier.py                 # 主張検証
├── notification.py             # 通知
├── file_system.py              # ファイルアクセス
├── secret.py                   # 秘密情報取得
├── audit.py                    # 監査ログ
└── rpa.py                      # RPA制御
```

### Port定義の例

```python
# piece/ports/ai.py

class AIPort(Protocol):
    """AI呼び出しの抽象。Anthropic/OpenAI/ローカルLLM、何でも差し替え可能。"""

    async def complete(self, system: str, user: str, model: str) -> str:
        """単純な補完"""
        ...

    async def ask_specialist(self, assignment: SpecialistAssignment) -> Investigation:
        """スペシャリストに調査依頼"""
        ...

    async def run_agent(self, prompt: str, tools: list[Tool]) -> AgentResult:
        """ツール付きエージェント実行"""
        ...


# piece/ports/knowledge.py

class KnowledgePort(Protocol):
    """知識の読み書き。PostgreSQL/SQLite/インメモリ、何でも差し替え可能。"""

    async def get_node(self, id: str) -> KnowledgeNode | None: ...
    async def save_node(self, node: KnowledgeNode) -> str: ...
    async def link_nodes(self, source_id: str, target_id: str, link_type: str) -> None: ...
    async def get_specialists(self) -> list[SpecialistConfig]: ...
    async def find_cached_answer(self, question: str) -> FinalResponse | None: ...
    async def save_from_response(self, question: str, response: FinalResponse) -> None: ...
    async def get_frontier(self) -> KnowledgeFrontier: ...
    async def get_stale_nodes(self) -> list[KnowledgeNode]: ...


# piece/ports/search.py

class SearchPort(Protocol):
    """検索の抽象。FAISS/pgvector/Elasticsearch、何でも差し替え可能。"""

    async def multi_strategy_search(self, query: str, limit: int = 10) -> list[SearchResult]: ...
    async def vector_search(self, embedding: list[float], limit: int) -> list[SearchResult]: ...
    async def text_search(self, query: str, limit: int) -> list[SearchResult]: ...


# piece/ports/collector.py

class CollectorPort(Protocol):
    """証拠収集の抽象。"""

    @property
    def name(self) -> str: ...
    @property
    def capabilities(self) -> list[str]: ...
    async def collect(self, target: Target, query: CollectorQuery) -> Evidence | CollectionError: ...
    async def is_available(self, target: Target) -> bool: ...


# piece/ports/prober.py

class ProberPort(Protocol):
    """能動検査の抽象。"""

    @property
    def name(self) -> str: ...
    @property
    def side_effects(self) -> SideEffectLevel: ...
    async def probe(self, target: Target, action: ProbeAction) -> Evidence | CollectionError: ...


# piece/ports/notification.py

class NotificationPort(Protocol):
    """通知の抽象。Slack/Email/In-app、何でも差し替え可能。"""

    async def notify(self, recipient: str, event: TicketEvent) -> None: ...
    async def notify_channel(self, channel: str, message: str) -> None: ...


# piece/ports/file_system.py

class FileSystemPort(Protocol):
    """ファイルアクセスの抽象。ローカル/S3/GCS、何でも差し替え可能。"""

    async def read(self, path: str) -> str: ...
    async def read_lines(self, path: str, start: int, end: int) -> str: ...
    async def exists(self, path: str) -> bool: ...
    async def glob(self, pattern: str) -> list[str]: ...


# piece/ports/secret.py

class SecretPort(Protocol):
    """秘密情報取得の抽象。Vault/AWS SM/env var、何でも差し替え可能。"""

    async def get(self, ref: str) -> str: ...


# piece/ports/audit.py

class AuditPort(Protocol):
    """監査ログの抽象。"""

    async def record(self, action: str, resource: str, details: dict) -> None: ...
```

---

## 5. Layer 3: Adapters（技術固有の実装）

**Portを実装する。** 技術固有のコードは全てここに閉じ込める。
1つのPortに対して複数のAdapterが存在可能。

```
piece/adapters/
├── __init__.py
│
├── ai/                         # AIPort の実装群
│   ├── __init__.py
│   ├── anthropic.py            # Anthropic SDK (Claude)
│   ├── openai.py               # OpenAI SDK (GPT) ← 将来の差し替え用
│   └── mock.py                 # テスト用モック
│
├── storage/                    # KnowledgePort の実装群
│   ├── __init__.py
│   ├── postgres.py             # PostgreSQL + pgvector
│   ├── sqlite.py               # SQLite (開発・テスト用)
│   └── memory.py               # インメモリ (テスト用)
│
├── search/                     # SearchPort の実装群
│   ├── __init__.py
│   ├── faiss_search.py         # FAISS HNSW
│   ├── pgvector_search.py      # pgvector
│   └── simple_search.py        # 単純な文字列マッチ (テスト用)
│
├── collectors/                 # CollectorPort の実装群
│   ├── __init__.py
│   ├── sentry.py               # Sentry (エラートラッカー)
│   ├── datadog.py              # Datadog (APM, ログ, メトリクス)
│   ├── cloudwatch.py           # AWS CloudWatch
│   ├── ssh_log.py              # SSH経由ログ取得
│   ├── docker_log.py           # Docker ログ
│   ├── git.py                  # Git履歴
│   ├── env_comparator.py       # 環境差分比較
│   ├── live_log.py             # リアルタイムログ
│   ├── queue_redis.py          # Redisキュー
│   ├── cache_redis.py          # Redisキャッシュ
│   └── external_status.py      # 外部サービスステータス
│
├── probers/                    # ProberPort の実装群
│   ├── __init__.py
│   ├── playwright.py           # ブラウザ自動操作
│   ├── http.py                 # API プロービング
│   ├── db_inspector.py         # DB状態検査
│   ├── auth_inspector.py       # 認証状態検査
│   ├── network.py              # DNS/SSL/ポート検査
│   ├── remote_debugger.py      # リモートデバッガ
│   └── hotfix.py               # ホットフィックス適用
│
├── verifiers/                  # VerifierPort の実装群
│   ├── __init__.py
│   ├── code_verifier.py        # tree-sitter AST検証
│   ├── ai_verifier.py          # AI論理検証 (Opus)
│   ├── consistency.py          # 矛盾検出
│   ├── temporal.py             # 時系列検証
│   ├── state.py                # 状態検証
│   └── regression.py           # 回帰テスト
│
├── notifications/              # NotificationPort の実装群
│   ├── __init__.py
│   ├── slack.py                # Slack
│   ├── email_sendgrid.py       # SendGrid
│   ├── email_ses.py            # AWS SES
│   └── console.py              # コンソール出力 (開発用)
│
├── file_systems/               # FileSystemPort の実装群
│   ├── __init__.py
│   ├── local.py                # ローカルファイルシステム
│   ├── s3.py                   # AWS S3
│   └── memory.py               # インメモリ (テスト用)
│
├── secrets/                    # SecretPort の実装群
│   ├── __init__.py
│   ├── vault.py                # HashiCorp Vault
│   ├── aws_sm.py               # AWS Secrets Manager
│   └── env_var.py              # 環境変数 (開発用)
│
├── ast/                        # AST解析（Verifierが使う）
│   ├── __init__.py
│   ├── tree_sitter.py          # tree-sitter
│   └── parser.py               # 言語非依存パーサー
│
├── nlp/                        # 自然言語処理
│   ├── __init__.py
│   ├── mecab_tokenizer.py      # MeCab日本語形態素解析
│   ├── embedder.py             # sentence-transformers
│   └── keyword_extractor.py    # キーワード抽出
│
└── graph/                      # グラフ処理
    ├── __init__.py
    └── networkx_graph.py       # NetworkX（拡散活性化、PageRank）
```

### Adapterの例

```python
# piece/adapters/ai/anthropic.py

class AnthropicAI:
    """AIPort の Anthropic実装"""

    implements = AIPort  # どのPortを実装しているか明示

    def __init__(self, api_key: str, default_model: str = "claude-sonnet-4-6"):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.default_model = default_model

    async def complete(self, system: str, user: str, model: str = None) -> str:
        response = await self.client.messages.create(
            model=model or self.default_model,
            system=system,
            messages=[{"role": "user", "content": user}],
            max_tokens=8192,
        )
        return response.content[0].text

    async def ask_specialist(self, assignment: SpecialistAssignment) -> Investigation:
        ...

    async def run_agent(self, prompt: str, tools: list[Tool]) -> AgentResult:
        agent = Agent(model=self.default_model, tools=tools)
        return await agent.run(prompt)


# piece/adapters/storage/postgres.py

class PostgresKnowledge:
    """KnowledgePort の PostgreSQL実装"""

    implements = KnowledgePort

    def __init__(self, dsn: str):
        self.engine = create_async_engine(dsn)

    async def get_node(self, id: str) -> KnowledgeNode | None:
        async with self.session() as s:
            row = await s.get(KnowledgeNodeModel, id)
            return row.to_domain() if row else None

    async def save_node(self, node: KnowledgeNode) -> str:
        async with self.session() as s:
            model = KnowledgeNodeModel.from_domain(node)
            s.add(model)
            await s.commit()
            return model.id


# piece/adapters/storage/memory.py

class InMemoryKnowledge:
    """KnowledgePort のインメモリ実装（テスト用）"""

    implements = KnowledgePort

    def __init__(self):
        self.nodes: dict[str, KnowledgeNode] = {}
        self.links: list[tuple[str, str, str]] = []
        self.cache: dict[str, FinalResponse] = {}

    async def get_node(self, id: str) -> KnowledgeNode | None:
        return self.nodes.get(id)

    async def save_node(self, node: KnowledgeNode) -> str:
        self.nodes[node.id] = node
        return node.id
```

---

## 6. Layer 4: Entry Points（外部との接点）

**アプリケーションの起動とDI（依存注入）を担当。**

```
piece/entry/
├── __init__.py
│
├── api/                        # FastAPI
│   ├── __init__.py
│   ├── app.py                  # FastAPIアプリ + DI設定
│   ├── routes/
│   │   ├── tickets.py
│   │   ├── knowledge.py
│   │   ├── curiosity.py
│   │   └── ...
│   ├── middleware/
│   │   ├── auth.py
│   │   ├── audit.py
│   │   ├── tenant.py
│   │   └── error.py
│   └── deps.py                 # FastAPI Depends
│
├── cli/                        # Typer CLI
│   ├── __init__.py
│   └── main.py
│
└── cron/                       # 定期実行
    ├── __init__.py
    ├── curiosity_loop.py       # 好奇心探索ループ
    └── sla_monitor.py          # SLA監視
```

### 依存注入（DI）

**Layer 4がAdapterを生成し、Use Caseに注入する。** ここだけが具体的な技術を知る。

```python
# piece/entry/api/app.py

from piece.usecases.ask import AskUseCase
from piece.adapters.ai.anthropic import AnthropicAI
from piece.adapters.storage.postgres import PostgresKnowledge
from piece.adapters.search.faiss_search import FAISSSearch
from piece.adapters.notifications.slack import SlackNotification

def create_app(config: AppConfig) -> FastAPI:
    app = FastAPI()

    # Adapter生成（技術固有のコードはここだけ）
    ai = AnthropicAI(api_key=config.anthropic_key)
    knowledge = PostgresKnowledge(dsn=config.database_url)
    search = FAISSSearch(index_path=config.faiss_index)
    notification = SlackNotification(token=config.slack_token)
    fact_check = ...
    response = ...

    # Use Case生成（Adapterを注入）
    ask_usecase = AskUseCase(
        knowledge_port=knowledge,
        ai_port=ai,
        search_port=search,
        fact_check_port=fact_check,
        response_port=response,
        notification_port=notification,
    )

    # ルート登録
    app.include_router(create_ticket_router(ask_usecase, ...))
    app.include_router(create_knowledge_router(knowledge, search, ...))

    return app


# テスト用: 全部モック
def create_test_app() -> FastAPI:
    return create_app_with(
        ai=MockAI(),
        knowledge=InMemoryKnowledge(),
        search=SimpleSearch(),
        notification=ConsoleNotification(),
    )
```

---

## 7. テスト戦略

```
Layer 0 テスト: 純粋関数テスト（モック不要）
  → 最も多く、最も速い
  → pytest だけで完結

Layer 1 テスト: Port モックでユニットテスト
  → Use Caseの分岐・ループ・エラーハンドリング
  → MockPort を注入

Layer 2 テスト: なし（インターフェース定義のみ）

Layer 3 テスト: 統合テスト（実技術を使う）
  → PostgresKnowledge: テスト用DBに接続
  → FAISSSearch: テスト用インデックス
  → AnthropicAI: APIモック or 実API (E2Eのみ)

Layer 4 テスト: E2Eテスト
  → FastAPI TestClient
  → 全層を結合してHTTP経由でテスト
```

```
テストピラミッド:

        /\
       /E2E\          Layer 4: 少数のシナリオテスト
      /------\
     /統合テスト\      Layer 3: Adapter単体テスト
    /----------\
   / Use Case   \     Layer 1: Portモックでロジックテスト
  /--------------\
 / Core Domain    \   Layer 0: 純粋関数テスト（最多）
/------------------\
```

---

## 8. 拡張パターン

### 新しい検索戦略を追加する

```
1. Layer 0 に戦略ロジックを追加（純粋関数）
   piece/core/search/new_strategy.py

2. 必要ならLayer 2 にPort追加（既存で足りなければ）

3. Layer 3 にAdapter追加
   piece/adapters/search/new_search.py

4. Layer 4 のDI設定でAdapterを登録

既存コードの変更: ゼロ
```

### 新しいCollector を追加する

```
1. piece/adapters/collectors/new_collector.py を作成
   → CollectorPort を実装

2. Layer 4 のRegistry に登録

既存コードの変更: ゼロ
```

### AIプロバイダをOpenAIに切り替える

```
1. piece/adapters/ai/openai.py を作成
   → AIPort を実装

2. Layer 4 のDI設定で AnthropicAI → OpenAI に差し替え

既存コードの変更: ゼロ
```

### DBをMongoDBに切り替える

```
1. piece/adapters/storage/mongodb.py を作成
   → KnowledgePort を実装

2. Layer 4 のDI設定で PostgresKnowledge → MongoDBKnowledge に差し替え

既存コードの変更: ゼロ
```

---

## 9. 最終パッケージ構成

```
piece/
├── pyproject.toml
│
├── piece/
│   ├── core/                   # Layer 0: 純粋ドメイン（依存ゼロ）
│   │   ├── types/              #   型定義
│   │   ├── rules/              #   ビジネスルール
│   │   ├── gates/              #   品質ゲート
│   │   ├── search/             #   検索アルゴリズム
│   │   └── frontier/           #   好奇心探索ロジック
│   │
│   ├── usecases/               # Layer 1: アプリケーションロジック（Port依存のみ）
│   │   ├── ask.py
│   │   ├── investigate.py
│   │   ├── analyze.py
│   │   ├── respond.py
│   │   ├── curiosity.py
│   │   └── ...
│   │
│   ├── ports/                  # Layer 2: 抽象インターフェース
│   │   ├── ai.py
│   │   ├── knowledge.py
│   │   ├── search.py
│   │   ├── collector.py
│   │   ├── prober.py
│   │   ├── notification.py
│   │   └── ...
│   │
│   ├── adapters/               # Layer 3: 技術固有の実装
│   │   ├── ai/                 #   Anthropic, OpenAI, Mock
│   │   ├── storage/            #   PostgreSQL, SQLite, Memory
│   │   ├── search/             #   FAISS, pgvector, Simple
│   │   ├── collectors/         #   Sentry, Datadog, SSH, Docker, ...
│   │   ├── probers/            #   Playwright, HTTP, DB, Auth, ...
│   │   ├── verifiers/          #   Code, AI, Consistency, ...
│   │   ├── notifications/      #   Slack, Email, Console
│   │   ├── file_systems/       #   Local, S3, Memory
│   │   ├── secrets/            #   Vault, AWS SM, EnvVar
│   │   ├── ast/                #   tree-sitter
│   │   ├── nlp/                #   MeCab, embedder
│   │   └── graph/              #   NetworkX
│   │
│   └── entry/                  # Layer 4: 外部との接点 + DI
│       ├── api/                #   FastAPI
│       ├── cli/                #   Typer
│       └── cron/               #   定期実行
│
├── rpa/                        # RPA層（独立サービス）
│   └── ...
│
└── tests/
    ├── core/                   # Layer 0 テスト（純粋関数、最多）
    ├── usecases/               # Layer 1 テスト（Portモック）
    ├── adapters/               # Layer 3 テスト（統合テスト）
    ├── entry/                  # Layer 4 テスト（E2E）
    └── benchmark/              # 9軸ベンチマーク
```

---

## 10. 依存ルール（まとめ）

```
Layer 0 (Core)     → 何にも依存しない。Python標準ライブラリのみ
Layer 1 (UseCases) → Layer 0 + Layer 2 (Ports) のみ
Layer 2 (Ports)    → Layer 0 のみ（型定義を参照）
Layer 3 (Adapters) → Layer 0 + Layer 2 + 外部ライブラリ
Layer 4 (Entry)    → 全層 + フレームワーク（FastAPI等）

禁止:
  Layer 0 → Layer 1, 2, 3, 4       ❌
  Layer 1 → Layer 3, 4             ❌
  Layer 2 → Layer 1, 3, 4          ❌
  Layer 3 → Layer 1, 4             ❌
  Layer 3 → Layer 3 (他のAdapter)  ❌
```

---

## 11. 既存設計書との対応

| 設計書 | Layer対応 |
|--------|----------|
| ARCHITECTURE.md 3層分離(Brain/Hands/Session) | Layer 3 Adapters に内包。Brain=ai/, Hands=collectors/+probers/, Session=storage/ |
| INTERFACES.md Collector/Prober/Verifier | Layer 2 Ports (collector.py, prober.py, verifier.py) |
| CURIOSITY.md 好奇心探索 | Layer 0 (frontier/), Layer 1 (curiosity.py) |
| DATA_SECURITY.md テナント分離 | Layer 3 storage/postgres.py + Layer 4 middleware/tenant.py |
| RESPONSE.md 8ゲート | Layer 0 (gates/), Layer 1 (respond.py) |
| OPERATIONS.md CS運用 | Layer 1 (hearing.py, notify.py), Layer 4 (routes/) |