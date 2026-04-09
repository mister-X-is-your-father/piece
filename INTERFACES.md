# PIECE v2 — Interface Design

全ての証拠収集・分析手段を統一的に扱うためのインターフェース設計。
具体実装ではなく**契約**を定義する。

---

## 1. 設計原則

### 1.1 証拠とは何か

システム内で扱われる全ての情報は**証拠(Evidence)**である。
コード、ログ、スクリーンショット、APIレスポンス、DB状態、全て。

```
証拠には3つの属性がある:
  1. 内容(what)   — 何が確認されたか
  2. 出所(where)  — どこから取得したか（追跡可能性）
  3. 確度(how sure) — どれくらい信頼できるか
```

### 1.2 抽象化の方針

```
全ての証拠収集手段は3つのインターフェースに集約する:

  Collector  — 既存データを取得する（ログ、メトリクス、履歴）
  Prober     — 能動的にシステムを突いて反応を見る（API、ブラウザ、DB）
  Verifier   — 主張と事実を照合する（ファクトチェック、アサーション）

これ以上分けない。これ以下にもしない。
```

---

## 2. Core Types

全インターフェースが共有する基底型。

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


# ─── 確信度 ───

class Confidence(Enum):
    HIGH = "high"        # 複数ソースで裏付け済み
    MEDIUM = "medium"    # 単一ソースで確認、実環境未検証
    LOW = "low"          # 推測ベース、裏付けなし

    @property
    def action(self) -> str:
        return {
            Confidence.HIGH:   "そのまま信用してよい",
            Confidence.MEDIUM: "該当箇所を確認推奨",
            Confidence.LOW:    "独自調査が必要",
        }[self]


# ─── 証拠 ───

@dataclass
class Evidence:
    """全ての証拠収集結果の基底型"""
    source: str              # 出所（例: "ssh://server-1:/var/log/app.log"）
    summary: str             # 1行要約（例: "5回のログイン失敗後にアカウントロック"）
    content: Any             # 具体的な内容（型は実装依存）
    confidence: Confidence   # 確度
    collected_at: datetime = field(default_factory=datetime.now)
    metadata: dict = field(default_factory=dict)  # 追加情報（自由形式）

    @property
    def is_trustworthy(self) -> bool:
        return self.confidence in (Confidence.HIGH, Confidence.MEDIUM)


# ─── 証拠コレクション ───

@dataclass
class EvidenceBundle:
    """複数ソースからの証拠をまとめたもの"""
    ticket_id: str
    evidences: list[Evidence]
    collected_at: datetime = field(default_factory=datetime.now)

    @property
    def high_confidence(self) -> list[Evidence]:
        return [e for e in self.evidences if e.confidence == Confidence.HIGH]

    @property
    def needs_review(self) -> list[Evidence]:
        return [e for e in self.evidences if e.confidence != Confidence.HIGH]

    @property
    def overall_confidence(self) -> Confidence:
        if not self.evidences:
            return Confidence.LOW
        confs = [e.confidence for e in self.evidences]
        if all(c == Confidence.HIGH for c in confs):
            return Confidence.HIGH
        if any(c == Confidence.HIGH for c in confs):
            return Confidence.MEDIUM
        return Confidence.LOW


# ─── ターゲット ───

@dataclass
class Target:
    """証拠収集の対象システム"""
    name: str            # 例: "production", "staging"
    type: str            # 例: "web_app", "api", "database", "server"
    url: str | None = None
    credentials_ref: str | None = None  # Vault参照
    metadata: dict = field(default_factory=dict)


# ─── エラー ───

@dataclass
class CollectionError:
    """証拠収集の失敗"""
    source: str
    reason: str
    recoverable: bool
    timestamp: datetime = field(default_factory=datetime.now)
```

---

## 3. Collector — 既存データの取得

**「あるものを持ってくる」役割。** ログ、メトリクス、履歴、トレースなど。
システムに影響を与えない。読み取りのみ。

```python
class Collector(ABC):
    """既存データを取得するインターフェース"""

    @property
    @abstractmethod
    def name(self) -> str:
        """このCollectorの識別名（例: "sentry", "ssh_log", "datadog_apm"）"""
        ...

    @property
    @abstractmethod
    def capabilities(self) -> list[str]:
        """取得できるデータの種類（例: ["error_events", "stacktrace", "user_impact"]）"""
        ...

    @abstractmethod
    async def collect(
        self,
        target: Target,
        query: CollectorQuery,
    ) -> Evidence | CollectionError:
        """
        データを取得して証拠として返す。

        Args:
            target: 取得対象のシステム
            query: 何をどの範囲で取得するか

        Returns:
            Evidence: 取得成功時の証拠
            CollectionError: 取得失敗時のエラー
        """
        ...

    @abstractmethod
    async def is_available(self, target: Target) -> bool:
        """このCollectorが対象システムに対して使用可能か"""
        ...


@dataclass
class CollectorQuery:
    """Collectorへの取得要求"""
    what: str                          # 何を取得するか（例: "error_logs", "traces", "metrics"）
    time_range: TimeRange | None = None  # いつからいつまで
    filters: dict = field(default_factory=dict)  # フィルタ条件（自由形式）
    limit: int = 100                   # 最大件数

@dataclass
class TimeRange:
    since: datetime
    until: datetime | None = None  # Noneなら現在まで
```

### Collectorの実装分類

```
PIECE Hands層（API経由、高速）:
  ┌─────────────────────┐
  │ ErrorTracker         │ Sentry, Bugsnag, Rollbar
  │   .collect()         │ → エラー詳細、スタックトレース、影響範囲
  ├─────────────────────┤
  │ APMCollector         │ Datadog APM, New Relic
  │   .collect()         │ → トレース、スパン、ボトルネック
  ├─────────────────────┤
  │ MetricsCollector     │ Prometheus, CloudWatch, Datadog Metrics
  │   .collect()         │ → CPU、メモリ、レイテンシ、エラーレート
  ├─────────────────────┤
  │ DeployCollector      │ GitHub Actions, Vercel, ArgoCD
  │   .collect()         │ → デプロイ履歴、diff、ロールバック情報
  ├─────────────────────┤
  │ GitCollector         │ git log, blame, diff
  │   .collect()         │ → コミット履歴、変更理由、著者
  ├─────────────────────┤
  │ StructuredLogCollector│ ログDB, Datadog Logs, CloudWatch Logs
  │   .collect()         │ → 構造化ログエントリ
  └─────────────────────┘

RPA層（物理アクセス必要）:
  ┌─────────────────────┐
  │ FileLogCollector     │ SSH, Docker logs, ファイルシステム
  │   .collect()         │ → 非構造化ログ行
  ├─────────────────────┤
  │ InfraCollector       │ SSH経由のシステム情報
  │   .collect()         │ → CPU, メモリ, ディスク, プロセス
  ├─────────────────────┤
  │ QueueCollector       │ Redis, Sidekiq, Bull, SQS
  │   .collect()         │ → キュー深度、ジョブ状態
  ├─────────────────────┤
  │ CacheCollector       │ Redis, Memcached
  │   .collect()         │ → キー状態、TTL、ヒット率
  ├─────────────────────┤
  │ BrowserLogCollector  │ Playwright DevTools
  │   .collect()         │ → Console, Network, Performance
  └─────────────────────┘
```

---

## 4. Prober — 能動的な検査

**「突いて反応を見る」役割。** API呼び出し、ブラウザ操作、DB問い合わせなど。
システムに読み取り以上の影響を与える可能性がある。

```python
class Prober(ABC):
    """能動的にシステムを検査するインターフェース"""

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def capabilities(self) -> list[str]:
        ...

    @property
    @abstractmethod
    def side_effects(self) -> SideEffectLevel:
        """この検査がシステムに与える影響のレベル"""
        ...

    @abstractmethod
    async def probe(
        self,
        target: Target,
        action: ProbeAction,
    ) -> Evidence | CollectionError:
        """
        対象システムを検査して結果を返す。

        Args:
            target: 検査対象
            action: 何をするか

        Returns:
            Evidence: 検査結果
            CollectionError: 失敗時のエラー
        """
        ...

    @abstractmethod
    async def is_available(self, target: Target) -> bool:
        ...


class SideEffectLevel(Enum):
    NONE = "none"          # 読み取りのみ（SELECT, GET）
    MINIMAL = "minimal"    # 一時的な影響（セッション作成、ログイン試行）
    MODERATE = "moderate"  # データ変更を伴う（テストデータ作成）
    DESTRUCTIVE = "destructive"  # 破壊的（削除、リセット）— 要承認


@dataclass
class ProbeAction:
    """Proberへの検査要求"""
    what: str                   # 何を検査するか（例: "login_flow", "api_response", "db_state"）
    steps: list[dict] | None = None  # ブラウザ操作等の手順（あれば）
    query: str | None = None    # DB/APIクエリ（あれば）
    assertions: list[dict] = field(default_factory=dict)  # 期待値（あれば）
    require_approval: bool = False  # 承認が必要か（side_effectsがMODERATE以上で自動true）
```

### Proberの実装分類

```
RPA層:
  ┌─────────────────────┐
  │ BrowserProber        │ Playwright
  │   side_effects: MIN  │ → 画面操作再現、スクリーンショット、フォーム入力
  ├─────────────────────┤
  │ APIProber            │ httpx
  │   side_effects: NONE │ → APIリクエスト送信、レスポンス検証
  ├─────────────────────┤
  │ DBProber             │ asyncpg, aiomysql
  │   side_effects: NONE │ → SELECTクエリ、データ状態確認
  │     (readonly)       │
  ├─────────────────────┤
  │ AuthProber           │ JWT decode, session store
  │   side_effects: MIN  │ → 認証状態、トークン有効性、セッション検査
  ├─────────────────────┤
  │ NetworkProber        │ DNS, SSL, TCP
  │   side_effects: NONE │ → DNS解決、SSL証明書、ポート到達性
  └─────────────────────┘
```

---

## 5. Verifier — 主張と事実の照合

**「本当にそうか」を確かめる役割。** ファクトチェック、アサーション検証、差分比較。
Collector/Proberが集めた証拠に対して、追加の検証レイヤーを提供する。

```python
class Verifier(ABC):
    """主張と事実を照合するインターフェース"""

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def verification_type(self) -> str:
        """検証の種類（例: "code_fact_check", "assertion", "diff_analysis"）"""
        ...

    @abstractmethod
    async def verify(
        self,
        claim: Claim,
        evidence: list[Evidence],
    ) -> Verdict:
        """
        主張を証拠に基づいて検証する。

        Args:
            claim: 検証対象の主張
            evidence: 検証に使う証拠群

        Returns:
            Verdict: 検証結果（確認/部分確認/否定/判定不能）
        """
        ...


@dataclass
class Claim:
    """検証対象の主張"""
    statement: str               # 主張の内容
    source: str                  # 誰がこの主張をしたか（例: "specialist:backend"）
    citation: Citation | None = None  # 根拠として挙げられた情報源

@dataclass
class Citation:
    file: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    url: str | None = None
    snippet: str | None = None


class VerdictStatus(Enum):
    CONFIRMED = "confirmed"      # 証拠が主張を裏付ける
    PARTIAL = "partial"          # 一部裏付け、一部不明
    REFUTED = "refuted"          # 証拠が主張と矛盾する
    UNVERIFIABLE = "unverifiable"  # 判定に十分な証拠がない

@dataclass
class Verdict:
    """検証結果"""
    status: VerdictStatus
    confidence: Confidence
    reasoning: str               # なぜこの判定に至ったか
    supporting_evidence: list[Evidence] = field(default_factory=list)
    contradicting_evidence: list[Evidence] = field(default_factory=list)
    action: str = ""             # エンジニアが何をすべきか

    def __post_init__(self):
        if not self.action:
            self.action = self.confidence.action
```

### Verifierの実装分類

```
PIECE Brain層:
  ┌──────────────────────┐
  │ CodeVerifier          │ tree-sitter + ファイル確認
  │                       │ → コード上の主張を検証（関数存在、型、行番号）
  ├──────────────────────┤
  │ AIVerifier            │ Claude Opus
  │                       │ → 複雑な論理的整合性をAIが判断
  ├──────────────────────┤
  │ ConsistencyVerifier   │ 矛盾検出
  │                       │ → 複数専門家の回答間の矛盾を検出
  ├──────────────────────┤
  │ TemporalVerifier      │ 時系列整合性
  │                       │ → 「AはBの後に起きた」等の時系列主張を検証
  ├──────────────────────┤
  │ StateVerifier         │ DB/キャッシュ状態との照合
  │                       │ → 「このレコードは存在する」等の状態主張を検証
  └──────────────────────┘
```

---

## 6. Registry — 手段の統一管理

全てのCollector/Prober/Verifierを一元管理し、動的に利用可能な手段を判断する。

```python
class EvidenceRegistry:
    """全ての証拠収集・検証手段を管理するレジストリ"""

    def __init__(self):
        self._collectors: dict[str, Collector] = {}
        self._probers: dict[str, Prober] = {}
        self._verifiers: dict[str, Verifier] = {}

    # ─── 登録 ───

    def register_collector(self, collector: Collector) -> None:
        self._collectors[collector.name] = collector

    def register_prober(self, prober: Prober) -> None:
        self._probers[prober.name] = prober

    def register_verifier(self, verifier: Verifier) -> None:
        self._verifiers[verifier.name] = verifier

    # ─── 探索 ───

    async def available_for(self, target: Target) -> AvailableTools:
        """対象システムに対して使えるツールを返す"""
        collectors = []
        probers = []
        for name, c in self._collectors.items():
            if await c.is_available(target):
                collectors.append(ToolInfo(name=name, capabilities=c.capabilities))
        for name, p in self._probers.items():
            if await p.is_available(target):
                probers.append(ToolInfo(
                    name=name,
                    capabilities=p.capabilities,
                    side_effects=p.side_effects,
                ))
        return AvailableTools(
            collectors=collectors,
            probers=probers,
            verifiers=[ToolInfo(name=v.name, capabilities=[v.verification_type])
                       for v in self._verifiers.values()],
        )

    def get_collector(self, name: str) -> Collector:
        return self._collectors[name]

    def get_prober(self, name: str) -> Prober:
        return self._probers[name]

    def get_verifier(self, name: str) -> Verifier:
        return self._verifiers[name]

    # ─── 能力検索 ───

    def find_by_capability(self, capability: str) -> list[str]:
        """特定の能力を持つツールを検索"""
        results = []
        for name, c in self._collectors.items():
            if capability in c.capabilities:
                results.append(f"collector:{name}")
        for name, p in self._probers.items():
            if capability in p.capabilities:
                results.append(f"prober:{name}")
        return results


@dataclass
class ToolInfo:
    name: str
    capabilities: list[str]
    side_effects: SideEffectLevel | None = None

@dataclass
class AvailableTools:
    collectors: list[ToolInfo]
    probers: list[ToolInfo]
    verifiers: list[ToolInfo]
```

---

## 7. Planner — 証拠収集の自律計画

Brain層がRegistry情報を使って、症状から最適な証拠収集計画を立てる。

```python
class EvidencePlanner:
    """症状から証拠収集計画を自律的に立案する"""

    def __init__(self, registry: EvidenceRegistry):
        self.registry = registry

    async def plan(
        self,
        symptom: str,
        target: Target,
        existing_evidence: list[Evidence] | None = None,
    ) -> EvidencePlan:
        """
        症状と対象から、最適な証拠収集計画を立てる。

        1. 対象に使えるツールを確認
        2. 症状を分類
        3. 必要な証拠の種類を決定
        4. 既に手元にある証拠を除外
        5. 収集順序を最適化（副作用なし→あり、高速→低速）
        """
        available = await self.registry.available_for(target)
        plan_steps = await self._generate_steps(symptom, available, existing_evidence)
        return EvidencePlan(
            symptom=symptom,
            target=target,
            steps=self._optimize_order(plan_steps),
        )

    def _optimize_order(self, steps: list[PlanStep]) -> list[PlanStep]:
        """副作用なし→あり、API直接→RPA経由、の順に並べ替え"""
        return sorted(steps, key=lambda s: (
            s.side_effects.value if s.side_effects else "",
            s.estimated_seconds,
        ))


@dataclass
class PlanStep:
    """計画の1ステップ"""
    tool_type: str              # "collector" | "prober" | "verifier"
    tool_name: str              # 具体的なツール名
    description: str            # 人間が読める説明
    query: dict                 # ツールに渡すパラメータ
    side_effects: SideEffectLevel | None = None
    estimated_seconds: int = 15
    depends_on: list[int] = field(default_factory=list)  # 先行ステップ番号

@dataclass
class EvidencePlan:
    symptom: str
    target: Target
    steps: list[PlanStep]

    @property
    def estimated_total_seconds(self) -> int:
        return sum(s.estimated_seconds for s in self.steps)

    @property
    def requires_approval(self) -> bool:
        return any(
            s.side_effects in (SideEffectLevel.MODERATE, SideEffectLevel.DESTRUCTIVE)
            for s in self.steps if s.side_effects
        )
```

---

## 8. Executor — 計画の実行

```python
class EvidenceExecutor:
    """証拠収集計画を実行し、結果をEvidenceBundleにまとめる"""

    def __init__(self, registry: EvidenceRegistry):
        self.registry = registry

    async def execute(
        self,
        plan: EvidencePlan,
        on_progress: Callable[[PlanStep, Evidence | CollectionError], None] | None = None,
    ) -> EvidenceBundle:
        """
        計画を実行する。

        - 依存関係を尊重して順序実行
        - 独立したステップは並行実行
        - 1ステップ失敗しても残りは続行
        - 進捗コールバックでリアルタイム通知
        """
        evidences: list[Evidence] = []
        errors: list[CollectionError] = []
        completed: set[int] = set()

        for i, step in enumerate(plan.steps):
            # 依存ステップの完了待ち
            if not all(d in completed for d in step.depends_on):
                continue

            try:
                evidence = await self._execute_step(step, plan.target)
                evidences.append(evidence)
                if on_progress:
                    on_progress(step, evidence)
            except Exception as e:
                error = CollectionError(
                    source=f"{step.tool_type}:{step.tool_name}",
                    reason=str(e),
                    recoverable=True,
                )
                errors.append(error)
                if on_progress:
                    on_progress(step, error)

            completed.add(i)

        return EvidenceBundle(
            ticket_id=plan.target.name,
            evidences=evidences,
        )

    async def _execute_step(self, step: PlanStep, target: Target) -> Evidence:
        match step.tool_type:
            case "collector":
                tool = self.registry.get_collector(step.tool_name)
                query = CollectorQuery(**step.query)
                result = await tool.collect(target, query)
            case "prober":
                tool = self.registry.get_prober(step.tool_name)
                action = ProbeAction(**step.query)
                result = await tool.probe(target, action)
            case "verifier":
                tool = self.registry.get_verifier(step.tool_name)
                claim = Claim(**step.query["claim"])
                evidence = step.query.get("evidence", [])
                result = await tool.verify(claim, evidence)
            case _:
                raise ValueError(f"Unknown tool type: {step.tool_type}")

        if isinstance(result, CollectionError):
            raise Exception(result.reason)
        return result
```

---

## 9. 全体の関係図

```
                    ┌─────────────────┐
                    │  EvidencePlanner │ ← Brain層が利用
                    │  (計画立案)       │
                    └────────┬────────┘
                             │ plan
                             ▼
                    ┌─────────────────┐
                    │ EvidenceExecutor │
                    │  (計画実行)       │
                    └────────┬────────┘
                             │ execute
                             ▼
                    ┌─────────────────┐
                    │ EvidenceRegistry │ ← 全ツールを管理
                    └──┬─────┬─────┬──┘
                       │     │     │
            ┌──────────┘     │     └──────────┐
            ▼                ▼                ▼
    ┌──────────────┐ ┌────────────┐ ┌──────────────┐
    │  Collectors   │ │  Probers   │ │  Verifiers   │
    │              │ │            │ │              │
    │ ErrorTracker │ │ Browser    │ │ Code         │
    │ APM          │ │ API        │ │ AI (Opus)    │
    │ Metrics      │ │ DB         │ │ Consistency  │
    │ Deploy       │ │ Auth       │ │ Temporal     │
    │ Git          │ │ Network    │ │ State        │
    │ Logs(構造化)  │ │            │ │              │
    │ Logs(SSH)    │ │            │ │              │
    │ Infra        │ │            │ │              │
    │ Queue        │ │            │ │              │
    │ Cache        │ │            │ │              │
    └──────────────┘ └────────────┘ └──────────────┘
            │                │                │
            ▼                ▼                ▼
    ┌─────────────────────────────────────────────┐
    │              Evidence / Verdict              │
    │         (統一された出力型)                     │
    └─────────────────────────────────────────────┘
            │
            ▼
    ┌──────────────────┐
    │  EvidenceBundle   │ → Brain層（判断）→ 回答生成
    └──────────────────┘
```

---

## 10. Agent SDKとの統合

全てのCollector/ProberをAgent SDKのツールとして公開する。
エージェントが自律的に「どのツールを使うか」を判断する。

```python
# piece/hands/tools.py

def register_evidence_tools(
    registry: EvidenceRegistry,
    agent: Agent,
    target: Target,
):
    """レジストリの全ツールをAgent SDKのツールとして登録する"""

    available = await registry.available_for(target)

    for collector_info in available.collectors:
        collector = registry.get_collector(collector_info.name)

        @agent.tool(name=f"collect_{collector_info.name}")
        async def collect(what: str, time_range: str = None, **filters):
            f"""[{collector_info.name}] {', '.join(collector_info.capabilities)}"""
            query = CollectorQuery(what=what, filters=filters)
            return await collector.collect(target, query)

    for prober_info in available.probers:
        prober = registry.get_prober(prober_info.name)

        @agent.tool(name=f"probe_{prober_info.name}")
        async def probe(what: str, **params):
            f"""[{prober_info.name}] {', '.join(prober_info.capabilities)} (副作用: {prober_info.side_effects})"""
            action = ProbeAction(what=what, **params)
            return await prober.probe(target, action)
```

これにより:
```
Specialist:「ログインエラーを調査する」
  → Agent SDK: 「collect_error_tracker, probe_browser, collect_ssh_log が使える」
  → Specialist: 「まず collect_error_tracker でSentryを確認しよう」
  → Specialist: 「次に probe_browser でログインを再現しよう」
  → 自律的にツールを選択して証拠を収集
```

---

## 11. インターフェース一覧（実装チェックリスト）

### Collectors（13種）

| 名前 | 配置 | capabilities | 実装優先度 |
|------|------|-------------|----------|
| structured_log | PIECE Hands | log_query, log_filter | **P0** |
| error_tracker | PIECE Hands | error_events, stacktrace, user_impact | **P0** |
| git | PIECE Hands | commit_history, diff, blame | **P0** |
| apm | PIECE Hands | traces, spans, bottleneck | P1 |
| metrics | PIECE Hands | cpu, memory, latency, error_rate | P1 |
| deploy | PIECE Hands | deploy_history, deploy_diff | P1 |
| file_log | RPA | unstructured_log, log_tail | **P0** |
| browser_log | RPA | console_log, network_log, performance | **P0** |
| infra | RPA | cpu, memory, disk, connections | P1 |
| queue | RPA | queue_depth, job_status, failed_jobs | P2 |
| cache | RPA | cache_state, ttl, hit_rate | P2 |
| external_status | PIECE Hands | service_status, uptime | P2 |
| session_replay | PIECE Hands | user_session, replay_url | P3 |

### Probers（5種）

| 名前 | 配置 | capabilities | side_effects | 実装優先度 |
|------|------|-------------|-------------|----------|
| browser | RPA | page_interaction, screenshot, form_fill | MINIMAL | **P0** |
| api | RPA | http_request, response_validation | NONE | **P0** |
| db | RPA | select_query, state_check | NONE | P1 |
| auth | RPA | token_decode, session_check, login_test | MINIMAL | P1 |
| network | RPA | dns_resolve, ssl_check, port_scan | NONE | P2 |

### Verifiers（5種）

| 名前 | 配置 | verification_type | 実装優先度 |
|------|------|-------------------|----------|
| code | PIECE Brain | code_fact_check | **P0** |
| ai | PIECE Brain | logical_consistency | **P0** |
| consistency | PIECE Brain | cross_source_contradiction | P1 |
| temporal | PIECE Brain | timeline_verification | P2 |
| state | PIECE Brain | state_assertion | P2 |
