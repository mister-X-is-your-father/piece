# PIECE — Curiosity Engine（好奇心探索エンジン）

自律的に知識の穴を発見し、埋め続ける仕組み。
問い合わせがなくても、常に「わかっていないこと」を探して調査する。

---

## 1. 何が足りないか

今のPIECEの知識構築は**受動的**。

```
現状: 質問が来る → 調べる → 知識が増える → 次の質問に活きる

問題:
  - 質問が来るまで知識は増えない
  - 質問されない領域は永遠にブラックボックス
  - 知識の穴があることすら認識できない
  - ロジックの繋がりが断片的（AとBは知ってるがA→Bの因果は知らない）
```

必要なのは**能動的な好奇心**。

```
理想: 常に「何がわかっていないか」を認識する
      → 最も価値のある未知を選ぶ
      → 自律的に調査する
      → 知識ネットワークに組み込む
      → 新たな未知が見える
      → 繰り返す
```

---

## 2. 設計思想

### 2.1 知識の3状態

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│   Known      │     │  Known       │     │   Unknown     │
│   Known      │     │  Unknown     │     │   Unknown     │
│              │     │              │     │               │
│  知っている   │     │ 知らないと    │     │  知らないこと  │
│  こと        │     │ 知っている    │     │  すら知らない  │
│              │     │ こと         │     │               │
│  (知識DB)    │     │ (Mystery)    │     │  (未発見)      │
└─────────────┘     └──────────────┘     └───────────────┘
       ↑                    ↑                     ↑
    充実させる           調査で埋める          好奇心で発見する
```

**Curiosity Engineの役割は「Unknown Unknown」を「Known Unknown」に変えること。**

そしてInvestigatorが「Known Unknown」を「Known Known」に変える。

### 2.2 パズルの比喩

```
コードベース = 巨大なジグソーパズル

Known Known    = はめ込み済みのピース
Known Unknown  = 枠は見えてるが中身がないピース（Mystery）
Unknown Unknown = パズルの箱を開けてすらいない部分

好奇心探索:
  1. はめ込み済みのピースの「端」を見る
  2. 隣接するはずのピースが見当たらない → 穴を発見
  3. その穴の形から、どんなピースが必要か推測
  4. 探しに行く
```

---

## 3. Knowledge Frontier（知識の辺境）

### 3.1 Frontierとは

「知っていること」と「知らないこと」の境界線。ここに最も価値のある未知がある。

```python
@dataclass
class KnowledgeFrontier:
    """知識の辺境 — 既知と未知の境界"""

    # 知識ノードの中で「外」に繋がっていない端
    dangling_references: list[DanglingRef]

    # 知識ノード間の論理的な飛躍（AとCは知ってるがBがない）
    logic_gaps: list[LogicGap]

    # MECEマトリクスの未カバーセル
    coverage_holes: list[CoverageHole]

    # 矛盾（2つの知識が対立している）
    contradictions: list[Contradiction]

    # 浅い知識（ノードはあるが根拠が弱い）
    shallow_knowledge: list[ShallowNode]

    # 孤立した知識（他のどこにも繋がっていない）
    isolated_nodes: list[str]


@dataclass
class DanglingRef:
    """知識が参照しているが、参照先が存在しないもの"""
    source_node_id: str        # 参照元
    reference: str             # 参照先（例: "AuthMiddlewareの内部実装"）
    context: str               # どんな文脈で参照されたか
    estimated_importance: float # この穴を埋める価値（0-1）

@dataclass
class LogicGap:
    """論理の飛躍 — AとCは知ってるがA→Cの道筋が不明"""
    node_a_id: str             # 起点
    node_c_id: str             # 終点
    missing_link: str          # 何が足りないか（推測）
    gap_type: str              # "causal" | "temporal" | "structural" | "functional"

@dataclass
class CoverageHole:
    """MECEマトリクスの穴"""
    matrix_id: str
    row: str
    col: str
    expected_knowledge: str    # ここに何があるべきか

@dataclass
class Contradiction:
    """矛盾する2つの知識"""
    node_a_id: str
    node_b_id: str
    claim_a: str
    claim_b: str
    severity: float            # 矛盾の深刻度（0-1）

@dataclass
class ShallowNode:
    """根拠が薄い知識"""
    node_id: str
    confidence: float
    citation_count: int        # 根拠の数
    reason: str                # なぜ浅いか
```

### 3.2 Frontier Scanner

知識DBを定期的にスキャンし、Frontierを検出する。

```python
class FrontierScanner:
    """知識の辺境を検出するスキャナー"""

    async def scan(self, knowledge_store: KnowledgeStore) -> KnowledgeFrontier:
        """全知識をスキャンしてFrontierを返す"""

        return KnowledgeFrontier(
            dangling_references=await self._find_dangling_refs(knowledge_store),
            logic_gaps=await self._find_logic_gaps(knowledge_store),
            coverage_holes=await self._find_coverage_holes(knowledge_store),
            contradictions=await self._find_contradictions(knowledge_store),
            shallow_knowledge=await self._find_shallow_nodes(knowledge_store),
            isolated_nodes=await self._find_isolated_nodes(knowledge_store),
        )

    async def _find_dangling_refs(self, ks: KnowledgeStore) -> list[DanglingRef]:
        """
        知識ノードの内容を解析し、他のノードで説明されていない概念・用語を検出。

        例: ノード「ログイン処理はAuthMiddlewareを経由する」があるが
            AuthMiddlewareの詳細を説明するノードがない
            → DanglingRef(reference="AuthMiddleware", context="ログイン処理")
        """
        ...

    async def _find_logic_gaps(self, ks: KnowledgeStore) -> list[LogicGap]:
        """
        知識グラフ上で「飛躍」を検出する。

        方法:
          1. 全ノードペアの最短経路を計算
          2. 意味的に近い（embedding距離が近い）のにグラフ上で遠い → gap
          3. A depends_on C だが、A→C の間に中間ノードがない → gap
        """
        ...

    async def _find_coverage_holes(self, ks: KnowledgeStore) -> list[CoverageHole]:
        """MECEマトリクスの未カバーセルを返す"""
        ...

    async def _find_contradictions(self, ks: KnowledgeStore) -> list[Contradiction]:
        """
        矛盾を検出する。

        方法:
          1. contradicts リンクを持つノードペア
          2. 同じファイルの同じ行について異なる主張をしているノードペア
          3. embedding が近いが内容が対立するノードペア（AI判定）
        """
        ...

    async def _find_shallow_nodes(self, ks: KnowledgeStore) -> list[ShallowNode]:
        """
        根拠が薄いノードを検出。

        基準:
          - citation数が0
          - confidenceが0.5未満
          - 「推測」「おそらく」「可能性がある」等の不確実語を含む
        """
        ...

    async def _find_isolated_nodes(self, ks: KnowledgeStore) -> list[str]:
        """
        どのノードからもリンクされておらず、どこにもリンクしていないノード。
        知識グラフの孤島。
        """
        ...
```

---

## 4. Curiosity Planner（好奇心の優先順位付け）

Frontierの穴のうち、**どれを先に埋めるか**を判断する。

```python
class CuriosityPlanner:
    """
    知識の穴に優先順位をつけ、探索計画を立てる。

    優先度の判断基準:
      1. 影響度 — この穴を埋めると何件の質問に答えられるようになるか
      2. 到達可能性 — 今持ってるツールで調査できるか
      3. 依存関係 — 他の穴を埋める前提になっているか
      4. 鮮度 — 最近発見された穴 > 古い穴（状況が変わってるかも）
    """

    async def prioritize(
        self,
        frontier: KnowledgeFrontier,
        recent_queries: list[str],      # 最近の質問（需要シグナル）
        available_tools: AvailableTools, # 使える手段
    ) -> list[ExplorationTask]:
        """穴に優先順位をつけて探索タスクリストを返す"""

        candidates: list[ExplorationTask] = []

        # 矛盾は最優先（知識の信頼性に関わる）
        for contradiction in frontier.contradictions:
            candidates.append(ExplorationTask(
                target=contradiction,
                task_type="resolve_contradiction",
                priority=self._score_contradiction(contradiction),
                description=f"矛盾の解消: '{contradiction.claim_a}' vs '{contradiction.claim_b}'",
                method="両方の主張をコードと照合し、正しい方を特定",
            ))

        # 論理の飛躍（因果チェーンの欠損）
        for gap in frontier.logic_gaps:
            candidates.append(ExplorationTask(
                target=gap,
                task_type="fill_logic_gap",
                priority=self._score_logic_gap(gap, recent_queries),
                description=f"論理の補完: {gap.node_a_id} → ??? → {gap.node_c_id}",
                method="中間の処理・変換・呼び出しを特定",
            ))

        # 垂れ下がり参照（知ってるはずなのに詳細がない）
        for ref in frontier.dangling_references:
            candidates.append(ExplorationTask(
                target=ref,
                task_type="resolve_reference",
                priority=self._score_dangling_ref(ref, recent_queries),
                description=f"参照先の調査: '{ref.reference}'",
                method="コード検索 + AST解析で参照先を特定・文書化",
            ))

        # MECEの穴（網羅性の担保）
        for hole in frontier.coverage_holes:
            candidates.append(ExplorationTask(
                target=hole,
                task_type="fill_coverage",
                priority=self._score_coverage_hole(hole),
                description=f"カバレッジ補完: {hole.row}×{hole.col}",
                method="該当領域のコードを分析し知識ノードを作成",
            ))

        # 浅い知識の深堀り
        for shallow in frontier.shallow_knowledge:
            candidates.append(ExplorationTask(
                target=shallow,
                task_type="deepen_knowledge",
                priority=self._score_shallow(shallow, recent_queries),
                description=f"知識の深堀り: confidence={shallow.confidence:.2f}",
                method="根拠となるコードを特定し、citationを追加",
            ))

        # 孤立ノードの接続
        for node_id in frontier.isolated_nodes:
            candidates.append(ExplorationTask(
                target=node_id,
                task_type="connect_isolated",
                priority=0.3,  # 低優先（壊れてないなら後回し）
                description=f"孤立ノードの接続: {node_id}",
                method="関連する既存ノードを検索しリンクを作成",
            ))

        # 優先順位でソート
        candidates.sort(key=lambda t: t.priority, reverse=True)
        return candidates

    def _score_contradiction(self, c: Contradiction) -> float:
        """矛盾の優先度。矛盾は知識の信頼性を壊すので常に高い。"""
        return 0.9 + c.severity * 0.1  # 0.9〜1.0

    def _score_logic_gap(self, gap: LogicGap, queries: list[str]) -> float:
        """
        論理の飛躍の優先度。
        最近の質問で関連するものがあれば優先度を上げる。
        """
        base = 0.6
        # 最近の質問との関連度を加算
        for q in queries:
            if self._is_related(q, gap):
                base += 0.15
        return min(base, 0.95)

    def _score_dangling_ref(self, ref: DanglingRef, queries: list[str]) -> float:
        """垂れ下がり参照の優先度。需要があれば高い。"""
        return ref.estimated_importance * 0.7 + \
               self._demand_signal(ref.reference, queries) * 0.3


@dataclass
class ExplorationTask:
    """好奇心探索タスク"""
    target: Any                # 探索対象（DanglingRef, LogicGap, etc.）
    task_type: str             # タスク種別
    priority: float            # 優先度（0-1）
    description: str           # 人間が読める説明
    method: str                # どうやって調査するか
    estimated_minutes: int = 5 # 推定所要時間
    depends_on: list[str] = field(default_factory=list)  # 先行タスク
```

---

## 5. Explorer Agent（探索エージェント）

実際に知識の穴を埋めるエージェント。Specialistとは別の存在。

```python
class ExplorerAgent:
    """
    好奇心駆動の自律探索エージェント。

    Specialistとの違い:
      Specialist = 質問に答える（受動的）
      Explorer   = 自分で問いを立てて調べに行く（能動的）
    """

    def __init__(self, registry: EvidenceRegistry, knowledge_store: KnowledgeStore):
        self.agent = Agent(
            model="claude-sonnet-4-6",  # 探索はSonnetで十分
            system_prompt=EXPLORER_SYSTEM,
            tools=[
                self.search_code,
                self.search_knowledge,
                self.read_file,
                self.analyze_ast,
                self.trace_dependency,
                self.create_knowledge,
                self.link_knowledge,
                self.resolve_mystery,
            ],
        )
        self.registry = registry
        self.knowledge_store = knowledge_store

    async def explore(self, task: ExplorationTask) -> ExplorationResult:
        """
        1つの探索タスクを実行する。

        エージェントが自律的に:
          - コードを検索・読解
          - 関連する既存知識を参照
          - 新しい知識ノードを作成
          - 既存ノードとのリンクを構築
          - 矛盾があれば解消
        """
        result = await self.agent.run(
            f"""## 探索タスク
タイプ: {task.task_type}
説明: {task.description}
方法: {task.method}

## ルール
1. 推測ではなくコードから事実を抽出すること
2. 発見した知識は create_knowledge ツールで保存すること
3. 既存知識との関連は link_knowledge ツールで接続すること
4. 確信が持てない情報はconfidence低で保存し「未確認」と明記すること
5. 調査中に新たな疑問が見つかったら、それもMysteryとして記録すること"""
        )

        return ExplorationResult(
            task=task,
            nodes_created=result.tool_calls_count("create_knowledge"),
            links_created=result.tool_calls_count("link_knowledge"),
            mysteries_found=result.tool_calls_count("create_mystery"),
            summary=result.content,
        )

    # ─── ツール定義 ───

    @tool
    async def search_code(self, query: str, file_pattern: str = None) -> list[dict]:
        """コードベースを検索する"""
        ...

    @tool
    async def search_knowledge(self, query: str) -> list[dict]:
        """既存の知識を検索する"""
        ...

    @tool
    async def read_file(self, path: str, start_line: int = None, end_line: int = None) -> str:
        """ソースコードを読む"""
        ...

    @tool
    async def analyze_ast(self, path: str, symbol: str = None) -> dict:
        """ファイルのAST構造を解析する"""
        ...

    @tool
    async def trace_dependency(self, file: str, direction: str = "both") -> dict:
        """ファイルの依存関係を追跡する（imports/imported_by）"""
        ...

    @tool
    async def create_knowledge(
        self, summary: str, content: str, node_type: str,
        confidence: float, tags: list[str],
        citations: list[dict],
    ) -> str:
        """新しい知識ノードを作成する。返り値はノードID。"""
        ...

    @tool
    async def link_knowledge(
        self, source_id: str, target_id: str,
        link_type: str, description: str,
    ) -> None:
        """2つの知識ノードをリンクする"""
        ...

    @tool
    async def resolve_mystery(self, mystery_id: str, resolution: str) -> None:
        """Mysteryを解決済みにする"""
        ...

    @tool
    async def create_mystery(self, title: str, description: str, priority: int) -> str:
        """新たなMysteryを登録する（調査中に見つけた新しい疑問）"""
        ...


EXPLORER_SYSTEM = """あなたは好奇心探索エージェントです。
知識の穴を自律的に発見し、埋めていく役割を持っています。

あなたは質問に答えるのではなく、**自分で問いを立てて調べに行く**存在です。

行動原則:
1. コードから事実を抽出する。推測しない。
2. 1つの事実につき1つの知識ノードを作る（原子的知識）。
3. 知識ノードは必ず他のノードとリンクする（孤立させない）。
4. 調査中に「これもわからない」と気づいたら、Mysteryとして記録する。
5. 矛盾を見つけたら、コードを確認して正しい方を残す。

出力:
- 何を調べたか
- 何がわかったか
- 何がまだわからないか（新たなMystery）
- 知識ネットワークがどう成長したか
"""
```

---

## 6. Curiosity Loop（好奇心ループ）

全体を統合する自律ループ。質問がなくても知識が成長し続ける。

```python
class CuriosityLoop:
    """
    好奇心駆動の自律知識成長ループ。

    ask（受動的成長）と並行して動く、能動的成長エンジン。
    """

    def __init__(
        self,
        scanner: FrontierScanner,
        planner: CuriosityPlanner,
        explorer: ExplorerAgent,
        knowledge_store: KnowledgeStore,
    ):
        self.scanner = scanner
        self.planner = planner
        self.explorer = explorer
        self.knowledge_store = knowledge_store

    async def run_cycle(self) -> CycleReport:
        """
        1サイクルの好奇心探索:
          1. Frontierスキャン（穴の検出）
          2. 優先順位付け（どの穴を先に埋めるか）
          3. 探索実行（穴を埋める）
          4. 振り返り（何が成長したか、新たな穴は）
        """
        # 1. Frontierスキャン
        frontier = await self.scanner.scan(self.knowledge_store)

        # 2. 優先順位付け
        recent_queries = self.knowledge_store.get_recent_queries(limit=50)
        tasks = await self.planner.prioritize(
            frontier, recent_queries, available_tools,
        )

        if not tasks:
            return CycleReport(
                explored=0,
                status="frontier_clear",
                message="全ての知識の穴が埋まっています",
            )

        # 3. 上位N件を探索
        max_tasks_per_cycle = 3
        results = []
        for task in tasks[:max_tasks_per_cycle]:
            result = await self.explorer.explore(task)
            results.append(result)

        # 4. 振り返り
        total_nodes = sum(r.nodes_created for r in results)
        total_links = sum(r.links_created for r in results)
        new_mysteries = sum(r.mysteries_found for r in results)

        return CycleReport(
            explored=len(results),
            nodes_created=total_nodes,
            links_created=total_links,
            new_mysteries=new_mysteries,
            frontier_before=frontier,
            tasks_completed=[r.task.description for r in results],
            status="explored",
        )

    async def run_continuous(self, interval_minutes: int = 30):
        """
        継続的に好奇心ループを回す。

        質問対応の合間に、バックグラウンドで知識を成長させる。
        """
        while True:
            report = await self.run_cycle()
            await self._log_report(report)

            if report.status == "frontier_clear":
                # 穴がない → より深い探索に切り替え
                await self._deep_exploration()

            await asyncio.sleep(interval_minutes * 60)

    async def _deep_exploration(self):
        """
        Frontierが清浄なとき（穴がないとき）の深堀り探索。

        既知の知識を「もっと深く」理解する:
          - 高confidenceノードの根拠をさらに補強
          - 関数レベル→行レベルの理解を深める
          - パフォーマンス特性、エッジケース、暗黙の前提を掘る
        """
        ...


@dataclass
class CycleReport:
    explored: int
    nodes_created: int = 0
    links_created: int = 0
    new_mysteries: int = 0
    frontier_before: KnowledgeFrontier | None = None
    tasks_completed: list[str] = field(default_factory=list)
    status: str = ""
    message: str = ""
```

---

## 7. Knowledge Network Visualizer

知識ネットワークの成長と穴を可視化する。

```python
@dataclass
class NetworkStats:
    """知識ネットワークの統計"""
    total_nodes: int
    total_links: int
    total_mysteries: int         # Known Unknown

    # 密度
    density: float               # links / (nodes * (nodes-1))
    avg_links_per_node: float
    max_links_node: str          # 最も接続の多いノード

    # カバレッジ
    mece_coverage: float         # MECEマトリクスのカバー率（0-1）
    frontier_size: int           # Frontierの穴の数
    contradiction_count: int     # 未解決の矛盾数
    isolated_count: int          # 孤立ノード数

    # 成長
    nodes_last_24h: int          # 直近24時間で増えたノード
    links_last_24h: int          # 直近24時間で増えたリンク
    mysteries_resolved_24h: int  # 直近24時間で解決した謎

    # 品質
    avg_confidence: float        # 全ノードの平均確信度
    high_confidence_ratio: float # HIGH確信度のノードの割合
    citation_coverage: float     # citationが1つ以上あるノードの割合


class NetworkVisualizer:
    """知識ネットワークの可視化"""

    async def generate_map(self, ks: KnowledgeStore) -> KnowledgeMap:
        """
        知識マップを生成する。

        ノードの色:
          緑 = HIGH confidence
          黄 = MEDIUM confidence
          赤 = LOW confidence
          灰 = 孤立

        リンクの太さ:
          太 = ヘッブ学習で強化済み（weight > 2.0）
          中 = 通常
          細 = 弱い接続（weight < 0.5）

        リンクの色:
          青 = depends_on / elaborates
          赤 = contradicts
          緑 = resolves
          灰 = related

        穴（Frontier）:
          破線の枠 = Known Unknown（Mystery）
          点線の矢印 = Logic Gap（推測される接続）
        """
        ...

    async def get_stats(self, ks: KnowledgeStore) -> NetworkStats:
        """ネットワーク統計を返す"""
        ...

    async def get_growth_trend(
        self, ks: KnowledgeStore, days: int = 30
    ) -> list[DailyGrowth]:
        """日次の知識成長トレンド"""
        ...


@dataclass
class DailyGrowth:
    date: str
    nodes_added: int
    links_added: int
    mysteries_found: int
    mysteries_resolved: int
    frontier_size: int           # その日のFrontierサイズ
    avg_confidence: float
```

---

## 8. 全体の統合

```
┌─────────────────────────────────────────────────┐
│              PIECE Harness                       │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │          Curiosity Engine                 │   │
│  │                                          │   │
│  │  FrontierScanner                         │   │
│  │    │ 「ここに穴がある」                    │   │
│  │    ▼                                     │   │
│  │  CuriosityPlanner                        │   │
│  │    │ 「この穴が最も価値が高い」            │   │
│  │    ▼                                     │   │
│  │  ExplorerAgent                           │   │
│  │    │ 「調べてきた。知識を追加した」         │   │
│  │    ▼                                     │   │
│  │  KnowledgeNetwork ←→ Knowledge Store     │   │
│  │    │                                     │   │
│  │    │ 新たな穴が見える                     │   │
│  │    └──→ FrontierScanner に戻る           │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐   │
│  │ Ask Flow   │  │Collector │  │ Verifier  │   │
│  │ (受動的)   │  │ / Prober │  │           │   │
│  │            │  │ (証拠)   │  │ (検証)    │   │
│  └──────┬─────┘  └─────┬────┘  └─────┬─────┘   │
│         │              │             │          │
│         └──────────────┴─────────────┘          │
│                    ↓                            │
│            Knowledge Store                      │
│         （全ての知識はここに集約）                  │
└─────────────────────────────────────────────────┘

2つの成長エンジン:
  受動的: 質問 → 回答 → 知識保存 → ヘッブ学習
  能動的: Frontier検出 → 優先順位 → 探索 → 知識保存 → 新Frontier検出
```

---

## 9. APIエンドポイント

```
# 好奇心探索
POST   /api/curiosity/scan           # Frontierスキャン実行
GET    /api/curiosity/frontier        # 現在のFrontier取得
POST   /api/curiosity/explore         # 探索タスク実行
GET    /api/curiosity/history         # 探索履歴

# 知識ネットワーク
GET    /api/network/stats             # ネットワーク統計
GET    /api/network/map               # 知識マップ（可視化用）
GET    /api/network/growth            # 成長トレンド
GET    /api/network/contradictions    # 未解決の矛盾一覧
GET    /api/network/gaps              # 論理の飛躍一覧

# 自動ループ
POST   /api/curiosity/loop/start     # バックグラウンドループ開始
POST   /api/curiosity/loop/stop      # ループ停止
GET    /api/curiosity/loop/status     # ループ状態
```

---

## 10. 好奇心の種類

Explorerは6種類の好奇心で動く:

| 好奇心の種類 | 駆動する問い | 探索の結果 |
|---|---|---|
| **矛盾解消** | 「AとBのどちらが正しい？」 | 正しい方を残し、間違いを修正 |
| **因果補完** | 「AはなぜCに至る？中間のBは？」 | 因果チェーンの完成 |
| **参照解決** | 「このXの詳細は？」 | 新しい知識ノード |
| **網羅補完** | 「このマトリクスのここが空」 | MECEカバレッジ向上 |
| **深堀り** | 「これは本当か？根拠は十分か？」 | citation追加、confidence向上 |
| **接続** | 「この知識は何に関係する？」 | リンク作成、ネットワーク密度向上 |
