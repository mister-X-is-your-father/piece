# PIECE v2 — Response Layer（回答生成層）設計

調査結果と証拠を受け取り、複数の品質ゲートを通過させて、
信頼できる回答を生成するパイプライン。

---

## 1. なぜ回答層が独立して必要か

```
今のPIECE:
  Specialist回答 → そのまま返す
  → 品質にバラつき。嘘混入。構造がバラバラ。提案なし。

問題:
  - Specialistは「調査のプロ」であって「回答のプロ」ではない
  - 調査結果と回答は別物。調査は正確でも、伝え方が悪ければ価値がない
  - 複数Specialistの結果統合が雑（ただ繋げるだけ）
  - 品質チェックなしで出荷している

理想:
  調査結果 → 品質ゲート1 → ゲート2 → ... → ゲートN → 回答
  全てのゲートを通過した回答だけが顧客に届く
```

---

## 2. 回答生成パイプライン全体像

```
調査結果 + 証拠 + ファクトチェック結果
  │
  ▼
┌─────────────────────────────────────────┐
│  Gate 1: 素材チェック（材料は揃っているか） │
└────────────────┬────────────────────────┘
                 │ NG → 追加調査を要求
                 ▼
┌─────────────────────────────────────────┐
│  Gate 2: 回答ドラフト生成                 │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Gate 3: 事実性チェック（嘘が混入してないか）│
└────────────────┬────────────────────────┘
                 │ NG → ドラフト修正 or 再生成
                 ▼
┌─────────────────────────────────────────┐
│  Gate 4: 完全性チェック（答えになっているか）│
└────────────────┬────────────────────────┘
                 │ NG → 不足部分を補完
                 ▼
┌─────────────────────────────────────────┐
│  Gate 5: 誠実性チェック（不確実さを認めてるか）│
└────────────────┬────────────────────────┘
                 │ NG → 不確実表現を追加
                 ▼
┌─────────────────────────────────────────┐
│  Gate 6: 可読性チェック（わかりやすいか）    │
└────────────────┬────────────────────────┘
                 │ NG → リライト
                 ▼
┌─────────────────────────────────────────┐
│  Gate 7: 行動可能性チェック（何をすべきか明確か）│
└────────────────┬────────────────────────┘
                 │ NG → アクション項目を追加
                 ▼
┌─────────────────────────────────────────┐
│  Gate 8: セキュリティチェック（秘密が漏れてないか）│
└────────────────┬────────────────────────┘
                 │ NG → マスキング
                 ▼
       ✅ 回答完成 → レビュー or 送信
```

---

## 3. Core Types

```python
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime


class GateResult(Enum):
    PASS = "pass"
    FAIL = "fail"
    WARN = "warn"      # 通過するが注意フラグ付き


@dataclass
class GateCheckResult:
    """1つのゲートの判定結果"""
    gate_name: str
    result: GateResult
    issues: list[str]          # 検出された問題
    suggestions: list[str]     # 修正提案
    auto_fixable: bool         # 自動修正可能か
    details: dict = field(default_factory=dict)


@dataclass
class ResponseDraft:
    """回答ドラフト（パイプラインを通過していく途中状態）"""
    content: str                            # 回答本文
    confidence: Confidence                  # 全体の確信度
    citations: list[Citation]               # 根拠一覧
    sections: list[ResponseSection]         # 構造化されたセクション
    gate_results: list[GateCheckResult] = field(default_factory=list)
    version: int = 1                        # 修正回数
    warnings: list[str] = field(default_factory=list)

    @property
    def passed_all_gates(self) -> bool:
        return all(g.result != GateResult.FAIL for g in self.gate_results)

    @property
    def has_warnings(self) -> bool:
        return any(g.result == GateResult.WARN for g in self.gate_results)


@dataclass
class ResponseSection:
    """回答の構造化セクション"""
    type: SectionType
    title: str
    content: str
    confidence: Confidence
    citations: list[Citation] = field(default_factory=list)


class SectionType(Enum):
    SUMMARY = "summary"             # 結論（最初に置く）
    CAUSE = "cause"                 # 原因分析
    EVIDENCE = "evidence"           # 根拠・証拠
    STEPS = "steps"                 # 処理フロー（番号付き）
    SOLUTION = "solution"           # 解決策・対処法
    RELATED = "related"             # 関連情報
    CAVEAT = "caveat"               # 注意点・不確実性の明示
    ACTION = "action"               # 顧客が取るべきアクション


@dataclass
class FinalResponse:
    """全ゲート通過済みの最終回答"""
    content: str
    structured: list[ResponseSection]
    overall_confidence: Confidence
    citations: list[Citation]
    action_items: list[str]              # 顧客が取るべきアクション
    review_points: list[ReviewPoint]     # エンジニアが確認すべき点
    gate_summary: dict                   # 各ゲートの通過状況
    metadata: ResponseMetadata


@dataclass
class ReviewPoint:
    """エンジニアが確認すべき点"""
    item: str
    confidence: Confidence
    reason: str                          # なぜ確認が必要か
    suggested_action: str                # 何を確認すべきか


@dataclass
class ResponseMetadata:
    specialists_consulted: list[str]
    evidence_count: int
    fact_check_summary: dict             # verified/partial/refuted counts
    total_citations: int
    generation_time_ms: int
    draft_versions: int                  # 何回リライトしたか
    gates_passed: int
    gates_warned: int
    gates_total: int
```

---

## 4. 各ゲートの設計

### Gate 1: 素材チェック（Material Gate）

**「回答を生成するのに十分な材料があるか」**

回答生成に入る前に、素材の品質と量を確認。足りなければ追加調査を要求。

```python
class MaterialGate:
    """素材の十分性を検証する"""

    async def check(
        self,
        question: str,
        investigations: list[Investigation],
        evidences: list[Evidence],
        fact_checks: list[FactCheck],
    ) -> GateCheckResult:
        issues = []
        suggestions = []

        # 1. 調査結果があるか
        if not investigations:
            issues.append("調査結果がゼロ。回答生成不可")
            return GateCheckResult(
                gate_name="material", result=GateResult.FAIL,
                issues=issues, suggestions=["スペシャリストに再調査を依頼"],
                auto_fixable=False,
            )

        # 2. ファクトチェック済みか
        if not fact_checks:
            issues.append("ファクトチェック未実施")
            suggestions.append("ファクトチェックを実行してから回答生成に進む")

        # 3. 確信度LOWの割合
        low_count = sum(1 for fc in fact_checks if fc.confidence == "low")
        if fact_checks and low_count / len(fact_checks) > 0.5:
            issues.append(f"確信度LOW が {low_count}/{len(fact_checks)} 件（過半数）")
            suggestions.append("追加調査 or 証拠収集で確信度を上げる")

        # 4. 質問のカテゴリに対して必要な材料
        category = self._classify_question(question)
        missing = self._check_required_materials(category, investigations, evidences)
        if missing:
            issues.extend(missing)
            suggestions.append("不足している材料を追加収集する")

        result = GateResult.FAIL if len(issues) > 2 else \
                 GateResult.WARN if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="material", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=False,
        )

    def _check_required_materials(
        self, category: str, investigations, evidences
    ) -> list[str]:
        """カテゴリごとに必要な材料を確認"""
        missing = []
        match category:
            case "flow":
                if not any("step" in str(i.answer).lower() for i in investigations):
                    missing.append("フロー質問だが処理ステップが調査結果に含まれていない")
            case "error":
                if not any(e.source_type in ("error_tracker", "file_log") for e in evidences):
                    missing.append("エラー質問だがログ/エラートラッカーの証拠がない")
            case "config":
                if not any("config" in str(e.content).lower() for e in evidences):
                    missing.append("設定質問だが設定ファイルの証拠がない")
        return missing
```

### Gate 2: ドラフト生成（Draft Generator）

**「素材から構造化された回答ドラフトを生成する」**

ゲートではなく生成器。ただし出力が次のゲートの入力になる。

```python
class DraftGenerator:
    """調査結果と証拠から構造化回答ドラフトを生成する"""

    def __init__(self):
        self.agent = Agent(
            model="claude-sonnet-4-6",
            system_prompt=DRAFT_GENERATOR_SYSTEM,
        )

    async def generate(
        self,
        question: str,
        investigations: list[Investigation],
        fact_checks: list[FactCheck],
        evidences: list[Evidence],
    ) -> ResponseDraft:
        result = await self.agent.run(
            self._build_prompt(question, investigations, fact_checks, evidences)
        )
        return self._parse_draft(result.content)

    def _build_prompt(self, question, investigations, fact_checks, evidences) -> str:
        return f"""以下の素材から、顧客への回答ドラフトを生成してください。

## 顧客の質問
{question}

## 調査結果
{self._format_investigations(investigations)}

## ファクトチェック結果
{self._format_fact_checks(fact_checks)}

## 収集された証拠
{self._format_evidences(evidences)}

## 回答の構造（必ずこの順序で）

### 結論（1-2文で結論を先に述べる）
### 原因分析（なぜこうなっているか）
### 根拠（コード・ログ・証拠への参照）
### 対処法（具体的な手順）
### 関連情報（注意点、関連する機能、Tips）
### 確認事項（確信度が中・低の項目を明示）

## ルール
1. 結論を最初に。理由は後。
2. 全ての主張に [source:file:Lx] 形式の根拠を付ける
3. 確信度LOWの情報は「未確認ですが」と明示する
4. 推測は「推測ですが」と明記する。断定しない
5. 顧客が次に何をすべきかを具体的に書く
6. 専門用語には簡潔な説明を添える"""


DRAFT_GENERATOR_SYSTEM = """あなたは回答ドラフト生成の専門家です。
調査結果と証拠を受け取り、顧客にわかりやすい回答を構築します。

あなたは調査をしません。与えられた素材だけで回答を組み立てます。
素材にないことは書きません。

回答は「結論→原因→根拠→対処→関連→確認事項」の順序で構造化します。
"""
```

### Gate 3: 事実性チェック（Factuality Gate）

**「ドラフトに嘘が混入していないか」**

ドラフト生成AIが素材を要約する際に、ニュアンスが変わったり、存在しない情報を追加してしまうリスクへの対策。

```python
class FactualityGate:
    """ドラフトの全主張が素材に裏付けられているか検証する"""

    async def check(
        self,
        draft: ResponseDraft,
        investigations: list[Investigation],
        fact_checks: list[FactCheck],
        evidences: list[Evidence],
    ) -> GateCheckResult:
        issues = []
        suggestions = []

        # 素材テキストを結合（照合用）
        material_text = self._combine_materials(investigations, fact_checks, evidences)
        material_lower = material_text.lower()

        for section in draft.sections:
            # 各セクションの主張が素材に存在するか
            claims = self._extract_claims(section.content)
            for claim in claims:
                if not self._is_grounded(claim, material_lower):
                    issues.append(
                        f"[{section.type.value}] 素材にない主張: 「{claim[:80]}」"
                    )
                    suggestions.append(f"削除するか「未確認」マーク付きにする")

        # 引用が実在するか
        for citation in draft.citations:
            if citation.file and not self._file_exists(citation.file):
                issues.append(f"存在しないファイルへの引用: {citation.file}")
                suggestions.append("引用を削除するか正しいパスに修正")

        # fact_checkでrefutedされた主張がドラフトに含まれていないか
        refuted = [fc for fc in fact_checks if fc.status == "refuted"]
        for fc in refuted:
            if fc.statement.lower() in draft.content.lower():
                issues.append(f"反証済みの主張がドラフトに残っている: 「{fc.statement[:80]}」")

        result = GateResult.FAIL if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="factuality", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=True,  # 該当箇所の削除/マーキングで自動修正可能
        )

    def _is_grounded(self, claim: str, material: str) -> bool:
        """主張が素材テキストのどこかに根拠を持つか"""
        # キーワード一致（厳密版はembedding類似度を使う）
        claim_keywords = set(claim.lower().split())
        claim_keywords -= STOP_WORDS
        if not claim_keywords:
            return True
        match_count = sum(1 for kw in claim_keywords if kw in material)
        return match_count / len(claim_keywords) >= 0.5
```

### Gate 4: 完全性チェック（Completeness Gate）

**「質問に対して答えになっているか」**

```python
class CompletenessGate:
    """質問の全側面に回答しているか検証する"""

    async def check(
        self,
        question: str,
        draft: ResponseDraft,
    ) -> GateCheckResult:
        issues = []
        suggestions = []

        # 質問から期待される回答要素を抽出
        expected = await self._extract_expected_elements(question)

        for element in expected:
            if not self._is_addressed(element, draft):
                issues.append(f"未回答: 「{element}」に答えていない")
                suggestions.append(f"「{element}」について調査結果から回答を補完する")

        # カテゴリ別の必須セクション
        category = self._classify_question(question)
        required_sections = self._required_sections(category)
        present_sections = {s.type for s in draft.sections}
        missing = required_sections - present_sections
        if missing:
            for sec in missing:
                issues.append(f"必須セクション欠落: {sec.value}")

        result = GateResult.FAIL if len(issues) > 2 else \
                 GateResult.WARN if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="completeness", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=True,
        )

    def _required_sections(self, category: str) -> set[SectionType]:
        """カテゴリごとの必須セクション"""
        base = {SectionType.SUMMARY, SectionType.EVIDENCE}
        match category:
            case "flow":
                return base | {SectionType.STEPS}
            case "error":
                return base | {SectionType.CAUSE, SectionType.SOLUTION}
            case "spec":
                return base | {SectionType.RELATED}
            case "config":
                return base | {SectionType.ACTION}
            case _:
                return base
```

### Gate 5: 誠実性チェック（Honesty Gate）

**「わからないことをわからないと言っているか」**

無知の知の原則。False Knownを回答に含ませない。

```python
class HonestyGate:
    """不確実な情報が適切にマークされているか検証する"""

    UNCERTAINTY_MARKERS_JP = ["未確認", "確認不可", "推測", "可能性があり", "不明"]
    UNCERTAINTY_MARKERS_EN = ["unconfirmed", "uncertain", "possibly", "might", "unclear"]
    ASSERTION_MARKERS = ["必ず", "絶対に", "常に", "100%", "確実に", "always", "never", "definitely"]

    async def check(
        self,
        draft: ResponseDraft,
        fact_checks: list[FactCheck],
    ) -> GateCheckResult:
        issues = []
        suggestions = []

        # 1. 確信度LOWの情報に不確実マーカーがあるか
        low_confidence_sections = [
            s for s in draft.sections if s.confidence == Confidence.LOW
        ]
        for section in low_confidence_sections:
            has_marker = any(
                m in section.content for m in
                self.UNCERTAINTY_MARKERS_JP + self.UNCERTAINTY_MARKERS_EN
            )
            if not has_marker:
                issues.append(
                    f"確信度LOWのセクション「{section.title}」に不確実性の表現がない。"
                    "知ったかぶりの疑い"
                )
                suggestions.append("「未確認ですが」「推測ですが」等の表現を追加する")

        # 2. 反証済みの情報が断定されていないか
        refuted = [fc for fc in fact_checks if fc.status == "refuted"]
        for fc in refuted:
            if any(m in draft.content for m in self.ASSERTION_MARKERS):
                issues.append(
                    f"反証済みの情報が断定表現で書かれている: {fc.statement[:60]}"
                )

        # 3. 全体が断定だらけでないか（疑いを持つ姿勢があるか）
        assertion_count = sum(
            1 for m in self.ASSERTION_MARKERS if m in draft.content
        )
        uncertainty_count = sum(
            1 for m in self.UNCERTAINTY_MARKERS_JP + self.UNCERTAINTY_MARKERS_EN
            if m in draft.content
        )
        if assertion_count > 5 and uncertainty_count == 0:
            issues.append("断定表現が多すぎる（5件以上）のに不確実表現がゼロ。過信の疑い")
            suggestions.append("本当に全て確実か再確認。1つでも不確実な点があれば明示する")

        # 4. 「わかりません」系の表現を必要に応じて含むか
        unverifiable = [fc for fc in fact_checks if fc.status == "unverifiable"]
        if unverifiable and not any(
            m in draft.content for m in ["確認できませんでした", "不明です", "わかりません", "情報が不足"]
        ):
            issues.append(
                f"検証不能な項目が{len(unverifiable)}件あるのに、"
                "「わからない」と認める表現がない"
            )

        result = GateResult.FAIL if len(issues) > 1 else \
                 GateResult.WARN if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="honesty", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=True,
        )
```

### Gate 6: 可読性チェック（Readability Gate）

**「顧客が読んで理解できるか」**

```python
class ReadabilityGate:
    """回答が読みやすく構造化されているか検証する"""

    async def check(self, draft: ResponseDraft) -> GateCheckResult:
        issues = []
        suggestions = []

        # 1. 結論が最初にあるか（結論ファースト）
        if draft.sections and draft.sections[0].type != SectionType.SUMMARY:
            issues.append("結論が最初にない。顧客は最初の3行で判断する")
            suggestions.append("SUMMARYセクションを最初に移動する")

        # 2. 長すぎないか
        total_chars = len(draft.content)
        if total_chars > 5000:
            issues.append(f"回答が長すぎる（{total_chars}字）。2000字以内が理想")
            suggestions.append("要約を強化し、詳細は折りたたみやリンクにする")

        # 3. 構造化されているか（見出し、箇条書き）
        has_headers = "##" in draft.content or "###" in draft.content
        has_bullets = "- " in draft.content or "1. " in draft.content
        if not has_headers:
            issues.append("見出しがない。壁のようなテキストは読みにくい")
        if not has_bullets:
            issues.append("箇条書きがない。情報の整理が不十分")

        # 4. 専門用語に説明があるか
        technical_terms = self._find_unexplained_terms(draft.content)
        if technical_terms:
            issues.append(f"説明なしの専門用語: {', '.join(technical_terms[:5])}")
            suggestions.append("専門用語に簡潔な説明を括弧内に追記する")

        # 5. コードブロックが適切か（生テキストにコードが混在してないか）
        bare_code = self._detect_bare_code(draft.content)
        if bare_code:
            issues.append("コードブロック外にコードが含まれている")
            suggestions.append("```で囲む")

        result = GateResult.FAIL if not has_headers and total_chars > 1000 else \
                 GateResult.WARN if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="readability", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=True,
        )
```

### Gate 7: 行動可能性チェック（Actionability Gate）

**「顧客が次に何をすべきか明確か」**

```python
class ActionabilityGate:
    """顧客が取るべき具体的アクションが含まれているか検証する"""

    async def check(
        self,
        question: str,
        draft: ResponseDraft,
    ) -> GateCheckResult:
        issues = []
        suggestions = []

        # 1. アクションセクションがあるか
        has_action = any(s.type == SectionType.ACTION for s in draft.sections)
        has_solution = any(s.type == SectionType.SOLUTION for s in draft.sections)

        if not has_action and not has_solution:
            issues.append("対処法も次のアクションもない。顧客は「で、どうすればいいの？」となる")
            suggestions.append("具体的な手順を追加する（1. xxx 2. xxx 3. xxx）")

        # 2. アクションが具体的か（「確認してください」だけでは不十分）
        if has_action or has_solution:
            action_sections = [
                s for s in draft.sections
                if s.type in (SectionType.ACTION, SectionType.SOLUTION)
            ]
            for section in action_sections:
                if len(section.content) < 50:
                    issues.append(f"アクションが短すぎる（{len(section.content)}字）。具体性が不足")
                if not any(c in section.content for c in ["1.", "2.", "- ", "手順"]):
                    issues.append("アクションが番号付きリストでない。手順が不明瞭")

        # 3. エラー質問なら解決策が必須
        if self._is_error_question(question) and not has_solution:
            issues.append("エラーに関する質問だが解決策がない")

        result = GateResult.FAIL if not (has_action or has_solution) else \
                 GateResult.WARN if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="actionability", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=True,
        )
```

### Gate 8: セキュリティチェック（Security Gate）

**「回答に秘密情報が漏れていないか」**

```python
class SecurityGate:
    """回答に秘密情報・内部情報が含まれていないか検証する"""

    SENSITIVE_PATTERNS = [
        (r'password\s*[=:]\s*\S+', "パスワード"),
        (r'api[_-]?key\s*[=:]\s*\S+', "APIキー"),
        (r'secret\s*[=:]\s*\S+', "シークレット"),
        (r'Bearer\s+[A-Za-z0-9\-._~+/]+=*', "Bearer token"),
        (r'-----BEGIN.*PRIVATE KEY', "秘密鍵"),
        (r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b', "内部IPアドレス"),
        (r'jdbc:|mysql://|postgres://|mongodb://', "DB接続文字列"),
        (r'vault://\S+', "Vault参照"),
    ]

    async def check(self, draft: ResponseDraft) -> GateCheckResult:
        issues = []
        suggestions = []

        for pattern, label in self.SENSITIVE_PATTERNS:
            matches = re.findall(pattern, draft.content, re.IGNORECASE)
            if matches:
                issues.append(f"秘密情報の漏洩: {label}が回答に含まれている")
                suggestions.append(f"{label}をマスクする（***に置換）")

        # 内部実装の過度な露出チェック
        internal_markers = [
            "内部実装", "社内", "internal", "private API",
            "管理者パスワード", "root password", "sudo",
        ]
        for marker in internal_markers:
            if marker.lower() in draft.content.lower():
                issues.append(f"内部情報の露出: 「{marker}」が含まれている")
                suggestions.append("顧客に見せるべきでない内部情報を削除する")

        result = GateResult.FAIL if any("秘密情報" in i for i in issues) else \
                 GateResult.WARN if issues else GateResult.PASS
        return GateCheckResult(
            gate_name="security", result=result,
            issues=issues, suggestions=suggestions,
            auto_fixable=True,  # マスキングで自動修正可能
        )
```

---

## 5. パイプライン実行エンジン

```python
class ResponsePipeline:
    """全ゲートを通過させて最終回答を生成する"""

    MAX_REVISIONS = 3  # 最大リライト回数

    def __init__(self):
        self.material_gate = MaterialGate()
        self.draft_generator = DraftGenerator()
        self.gates: list[Gate] = [
            FactualityGate(),      # 嘘がないか
            CompletenessGate(),    # 答えになってるか
            HonestyGate(),         # 不確実さを認めてるか
            ReadabilityGate(),     # わかりやすいか
            ActionabilityGate(),   # 何をすべきか明確か
            SecurityGate(),        # 秘密が漏れてないか
        ]
        self.fixer = DraftFixer()  # 自動修正エージェント

    async def generate(
        self,
        question: str,
        investigations: list[Investigation],
        fact_checks: list[FactCheck],
        evidences: list[Evidence],
    ) -> FinalResponse:
        # Gate 1: 素材チェック
        material_check = await self.material_gate.check(
            question, investigations, evidences, fact_checks,
        )
        if material_check.result == GateResult.FAIL:
            raise InsufficientMaterialError(material_check.issues)

        # Gate 2: ドラフト生成
        draft = await self.draft_generator.generate(
            question, investigations, fact_checks, evidences,
        )

        # Gate 3-8: 品質ゲート（失敗→自動修正→再チェック）
        for revision in range(self.MAX_REVISIONS):
            all_passed = True

            for gate in self.gates:
                result = await gate.check(
                    draft=draft,
                    question=question,
                    fact_checks=fact_checks,
                )
                draft.gate_results.append(result)

                if result.result == GateResult.FAIL:
                    all_passed = False
                    if result.auto_fixable:
                        # 自動修正
                        draft = await self.fixer.fix(draft, result)
                        draft.version += 1
                        break  # 修正後、最初のゲートから再チェック
                    else:
                        # 自動修正不可 → 警告付きで通過
                        draft.warnings.append(
                            f"[{result.gate_name}] {'; '.join(result.issues)}"
                        )

            if all_passed:
                break

        return self._finalize(draft, question)

    def _finalize(self, draft: ResponseDraft, question: str) -> FinalResponse:
        """ドラフトを最終回答に変換する"""
        # レビューポイント（確信度中・低の項目）を抽出
        review_points = []
        for section in draft.sections:
            if section.confidence != Confidence.HIGH:
                review_points.append(ReviewPoint(
                    item=section.title,
                    confidence=section.confidence,
                    reason=f"確信度{section.confidence.value}",
                    suggested_action=section.confidence.action,
                ))

        # アクション項目を抽出
        action_items = []
        for section in draft.sections:
            if section.type in (SectionType.ACTION, SectionType.SOLUTION):
                items = re.findall(r'^\d+\.\s*(.+)$', section.content, re.MULTILINE)
                action_items.extend(items)

        return FinalResponse(
            content=draft.content,
            structured=draft.sections,
            overall_confidence=draft.confidence,
            citations=draft.citations,
            action_items=action_items,
            review_points=review_points,
            gate_summary={
                g.gate_name: g.result.value for g in draft.gate_results
            },
            metadata=ResponseMetadata(
                specialists_consulted=[],  # 呼び出し元から渡される
                evidence_count=len(draft.citations),
                fact_check_summary={},
                total_citations=len(draft.citations),
                generation_time_ms=0,
                draft_versions=draft.version,
                gates_passed=sum(1 for g in draft.gate_results if g.result == GateResult.PASS),
                gates_warned=sum(1 for g in draft.gate_results if g.result == GateResult.WARN),
                gates_total=len(draft.gate_results),
            ),
        )
```

---

## 6. 自動修正エージェント（DraftFixer）

ゲートが失敗したとき、指摘に基づいてドラフトを自動修正する。

```python
class DraftFixer:
    """ゲートの指摘に基づいてドラフトを自動修正する"""

    def __init__(self):
        self.agent = Agent(
            model="claude-sonnet-4-6",
            system_prompt=FIXER_SYSTEM,
        )

    async def fix(
        self,
        draft: ResponseDraft,
        gate_result: GateCheckResult,
    ) -> ResponseDraft:
        result = await self.agent.run(f"""
## 修正対象の回答ドラフト
{draft.content}

## ゲート「{gate_result.gate_name}」の指摘
問題:
{chr(10).join(f'- {i}' for i in gate_result.issues)}

修正提案:
{chr(10).join(f'- {s}' for s in gate_result.suggestions)}

## 指示
上記の問題を修正してください。
修正以外の部分は変更しないでください。
引用（[source:...]）は保持してください。
""")
        return self._parse_fixed_draft(result.content, draft)


FIXER_SYSTEM = """あなたは回答ドラフトの修正専門家です。
品質ゲートが検出した問題を、最小限の変更で修正します。

ルール:
1. 指摘された問題のみ修正する。それ以外は触らない
2. 引用は保持する
3. 構造（セクション順序）は維持する
4. 新しい情報を追加しない（素材にないことは書かない）
5. 削除が最善なら削除する（無理に残さない）
"""
```

---

## 7. 回答テンプレート

カテゴリごとの回答構造テンプレート。

```python
RESPONSE_TEMPLATES = {
    "error": {
        "sections": [
            SectionType.SUMMARY,    # 「〇〇が原因です」
            SectionType.CAUSE,      # 原因の詳細
            SectionType.EVIDENCE,   # ログ、スクショ、コード
            SectionType.SOLUTION,   # 解決手順（番号付き）
            SectionType.CAVEAT,     # 不確実な部分
            SectionType.RELATED,    # 関連する既知の問題
        ],
        "tone": "concrete",        # 具体的に
    },
    "flow": {
        "sections": [
            SectionType.SUMMARY,    # 「〇〇は以下の順で処理されます」
            SectionType.STEPS,      # 1→2→3→...（番号付き、ファイルパス付き）
            SectionType.EVIDENCE,   # コード参照
            SectionType.RELATED,    # 関連フロー
            SectionType.CAVEAT,     # エッジケース
        ],
        "tone": "precise",         # 正確に
    },
    "spec": {
        "sections": [
            SectionType.SUMMARY,    # 「〇〇はXXXという仕組みです」
            SectionType.EVIDENCE,   # コード根拠
            SectionType.RELATED,    # 関連する仕様
            SectionType.CAVEAT,     # 制限事項
        ],
        "tone": "explanatory",     # 説明的に
    },
    "config": {
        "sections": [
            SectionType.SUMMARY,    # 「デフォルト値はXXXです」
            SectionType.EVIDENCE,   # 設定ファイルの参照
            SectionType.ACTION,     # 変更手順
            SectionType.CAVEAT,     # 変更時の注意点
        ],
        "tone": "instructional",   # 手順型
    },
}
```

---

## 8. 全体の接続

```
Manager
  │ 調査完了
  ▼
ResponsePipeline.generate(
    question,
    investigations,    ← Specialist調査結果
    fact_checks,       ← FactChecker検証結果
    evidences,         ← Collector/Proberの証拠
)
  │
  ├── Gate 1: 素材チェック          → NG: 追加調査を要求（Managerに差し戻し）
  ├── Gate 2: ドラフト生成          → AI生成
  ├── Gate 3: 事実性チェック        → NG: DraftFixerで嘘を削除/修正
  ├── Gate 4: 完全性チェック        → NG: DraftFixerで不足を補完
  ├── Gate 5: 誠実性チェック        → NG: DraftFixerで不確実表現を追加
  ├── Gate 6: 可読性チェック        → NG: DraftFixerでリライト
  ├── Gate 7: 行動可能性チェック    → NG: DraftFixerでアクション追加
  └── Gate 8: セキュリティチェック  → NG: DraftFixerでマスキング
  │
  ▼
FinalResponse
  ├── content: 回答本文
  ├── review_points: エンジニア確認ポイント（確信度中・低のみ）
  ├── action_items: 顧客が取るべきアクション
  ├── gate_summary: 全ゲートの通過状況
  └── metadata: 統計情報
  │
  ▼
エンジニアレビュー
  → 確認ポイントだけチェック → 承認 → 送信
```

---

## 9. ゲート一覧

| # | ゲート | 守るもの | FAIL時 | 自動修正 |
|---|--------|---------|--------|---------|
| 1 | 素材 | 材料不足の回答を防ぐ | 追加調査を要求 | ❌ |
| 2 | ドラフト生成 | — | — | — |
| 3 | **事実性** | 嘘の混入を防ぐ | 嘘を削除/修正 | ✅ |
| 4 | **完全性** | 質問に答えてない回答を防ぐ | 不足を補完 | ✅ |
| 5 | **誠実性** | 知ったかぶりを防ぐ | 不確実表現を追加 | ✅ |
| 6 | 可読性 | 読みにくい回答を防ぐ | リライト | ✅ |
| 7 | 行動可能性 | 「で、どうすればいいの？」を防ぐ | アクション追加 | ✅ |
| 8 | **セキュリティ** | 秘密漏洩を防ぐ | マスキング | ✅ |
