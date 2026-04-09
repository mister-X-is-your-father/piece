# PIECE v2 — Platform Design（汎用プラットフォーム設計）

PIECEは特定のSaaSに依存しない。
**どんなSaaSにも接続できる汎用カスタマーサポート調査ハーネス。**

---

## 1. PIECEが知らないこと

```
PIECEのコアは以下を一切知らない:

  ❌ 対象プロダクトが何か（会計ソフト？EC？CRM？）
  ❌ 技術スタックが何か（Rails？Next.js？Laravel？）
  ❌ DBが何か（PostgreSQL？MySQL？MongoDB？）
  ❌ インフラがどこか（AWS？GCP？オンプレ？）
  ❌ ログがどこにあるか（Datadog？CloudWatch？ファイル？）
  ❌ 認証方式が何か（JWT？Session？OAuth？SAML？）
  ❌ ドメイン用語が何か（「請求書」「在庫」「患者」？）
  ❌ ビジネスルールが何か（「返金は30日以内」？）

これら全ては「プロダクトプロファイル」として外から注入される。
```

---

## 2. Product Profile（プロダクトプロファイル）

SaaS 1つにつき1つのProfile。PIECEに「お前が相手にするプロダクトはこういうものだ」と教える設定。

```yaml
# profiles/freee.yaml

product:
  name: freee会計
  description: クラウド会計ソフト。個人事業主〜中小企業向け
  domain: 会計・経理
  url: https://www.freee.co.jp

# ドメイン知識（PIECEが知らない業務用語を教える）
domain_knowledge:
  terminology:
    - term: 仕訳
      description: 取引を借方・貸方に分けて記録すること
      aliases: [journal_entry, 仕分け]
    - term: 勘定科目
      description: 取引を分類するための項目（売上、仕入、給与等）
      aliases: [account, 科目]
    - term: 確定申告
      description: 1年間の所得と税額を税務署に申告する手続き
      aliases: [tax_return, 申告]
  business_rules:
    - rule: 年度締め後の仕訳修正は原則不可
      exception: 管理者権限で修正仕訳として登録可能
    - rule: freeeのデータはAPI経由で外部連携可能
      note: OAuth2認証が必要

# コードベース
codebase:
  repositories:
    - name: freee-web
      url: https://github.com/example/freee-web
      branch: main
      language: TypeScript
      framework: Next.js
      directories:
        frontend: src/components/
        api: src/pages/api/
        services: src/services/
    - name: freee-api
      url: https://github.com/example/freee-api
      branch: main
      language: Ruby
      framework: Rails
      directories:
        controllers: app/controllers/
        models: app/models/
        services: app/services/

# スペシャリスト定義（このプロダクト用）
specialists:
  - name: 仕訳・記帳
    description: 仕訳入力、自動仕訳、勘定科目に関する調査
    repositories: [freee-web, freee-api]
    keywords: [仕訳, journal, 勘定科目, account, 記帳]
    files:
      - freee-web:src/components/journal/**
      - freee-api:app/models/journal_entry.rb
      - freee-api:app/services/journal_service.rb

  - name: 確定申告
    description: 確定申告書の作成、e-Tax連携に関する調査
    repositories: [freee-web, freee-api]
    keywords: [確定申告, tax_return, 申告, e-Tax]

  - name: 請求書
    description: 請求書の作成・送付・入金管理に関する調査
    repositories: [freee-web, freee-api]
    keywords: [請求書, invoice, 入金, payment]

# 接続先（Collector/Proberが接続するシステム）
connections:
  monitoring:
    type: datadog
    api_key_ref: vault://freee/datadog_key
    service: freee-api

  error_tracking:
    type: sentry
    dsn_ref: vault://freee/sentry_dsn
    project: freee-web

  logs:
    structured:
      type: cloudwatch
      region: ap-northeast-1
      log_group: /ecs/freee-api
    unstructured:
      - type: ssh
        host: freee-worker-1
        key_ref: vault://freee/ssh_key
        paths: [/var/log/sidekiq/sidekiq.log]

  database:
    type: postgresql
    host_ref: vault://freee/db_host
    readonly_replica: true    # 読み取り専用レプリカに接続

  cache:
    type: redis
    host_ref: vault://freee/redis_host

  queue:
    type: sidekiq
    redis_ref: vault://freee/sidekiq_redis

  environments:
    staging:
      url: https://staging.freee.example.com
      auth:
        type: session_cookie
        login_url: /login
        credentials_ref: vault://freee/staging_admin
    production:
      url: https://app.freee.co.jp
      auth:
        type: oauth2
        credentials_ref: vault://freee/prod_readonly

# 回答スタイル
response_style:
  language: ja
  formality: polite           # polite / casual / formal
  company_name: freee株式会社
  support_email: support@freee.co.jp
  greeting_template: |
    お問い合わせいただきありがとうございます。
    freeeカスタマーサポートでございます。
  closing_template: |
    ご不明な点がございましたら、お気軽にお問い合わせください。
    今後ともfreeeをよろしくお願いいたします。
  forbidden_terms:            # 回答で使ってはいけない表現
    - バグ → 「不具合」と表現する
    - 仕様です → 「現在の動作として〜」と表現する
    - わかりません → 「確認中でございます」と表現する

# カスタム調査手順
investigation_playbooks:
  - trigger: "仕訳.*エラー"
    steps:
      - check: 勘定科目マスタの整合性
        tool: db_inspector
        query: "SELECT * FROM accounts WHERE deleted_at IS NULL AND ..."
      - check: 仕訳バリデーションログ
        tool: structured_log
        query: "level:error service:journal-validation"
      - check: フロントの入力値
        tool: browser_prober
        steps: [仕訳入力画面を開く, 同じ条件で入力, エラーを再現]
```

---

## 3. Profile Loader（プロファイル読み込み）

```python
# piece/core/types/profile.py （Layer 0: 型定義のみ）

@dataclass
class ProductProfile:
    """プロダクト定義。PIECEに何を相手にするか教える。"""
    product: ProductInfo
    domain_knowledge: DomainKnowledge
    codebase: CodebaseConfig
    specialists: list[SpecialistConfig]
    connections: ConnectionConfig
    response_style: ResponseStyle
    investigation_playbooks: list[Playbook]

@dataclass
class ProductInfo:
    name: str
    description: str
    domain: str
    url: str

@dataclass
class DomainKnowledge:
    terminology: list[Term]
    business_rules: list[BusinessRule]

@dataclass
class Term:
    term: str
    description: str
    aliases: list[str]

@dataclass
class BusinessRule:
    rule: str
    exception: str | None = None
    note: str | None = None

@dataclass
class ResponseStyle:
    language: str
    formality: str
    company_name: str
    support_email: str
    greeting_template: str
    closing_template: str
    forbidden_terms: dict[str, str]    # 禁止表現 → 代替表現
```

```python
# piece/adapters/profile/yaml_loader.py （Layer 3: YAML読み込み）

class YAMLProfileLoader:
    """YAMLファイルからProductProfileを読み込む"""

    implements = ProfilePort

    async def load(self, path: str) -> ProductProfile:
        with open(path) as f:
            raw = yaml.safe_load(f)
        return ProductProfile(
            product=ProductInfo(**raw["product"]),
            domain_knowledge=self._parse_domain(raw.get("domain_knowledge", {})),
            codebase=self._parse_codebase(raw.get("codebase", {})),
            specialists=self._parse_specialists(raw.get("specialists", [])),
            connections=self._parse_connections(raw.get("connections", {})),
            response_style=self._parse_style(raw.get("response_style", {})),
            investigation_playbooks=self._parse_playbooks(raw.get("investigation_playbooks", [])),
        )
```

---

## 4. Profileがシステムの各層にどう影響するか

```
Profile
  │
  ├──→ Brain (Layer 1 UseCases)
  │     ├── ルーティング: specialists定義でスペシャリスト振り分け
  │     ├── ヒアリング: domain_knowledgeで質問を最適化
  │     ├── 回答生成: response_styleでトーン・用語を制御
  │     └── 調査: investigation_playbooksでカスタム手順を実行
  │
  ├──→ Hands (Layer 3 Adapters)
  │     ├── Collector: connections.monitoringでDatadog/Sentry接続
  │     ├── Prober: connections.environmentsでブラウザ操作先を決定
  │     ├── DB: connections.databaseで接続先を決定
  │     └── Log: connections.logsでログ取得先を決定
  │
  ├──→ Search (Layer 0 Core + Layer 3)
  │     ├── 概念メッシュ: terminology.aliasesでクロスリンク自動生成
  │     └── キーワード: specialists.keywordsでルーティング辞書を構築
  │
  └──→ Response (Layer 0 Gates + Layer 1)
        ├── 顧客向け回答: greeting_template, closing_template
        ├── 禁止表現: forbidden_termsで自動フィルタ
        └── 技術レベル調整: response_style.formalityで調整
```

---

## 5. マルチプロダクト対応

1つのPIECEインスタンスで複数のSaaSを同時にサポートする。

```
テナント = 1つの組織（例: freee株式会社）
プロダクト = 1つのSaaS（例: freee会計、freee人事労務、freee申告）

テナント : プロダクト = 1 : N

組織Aが3つのSaaSを運営している場合:
  tenant: 組織A
    ├── product: SaaS-1 (profiles/saas1.yaml)
    ├── product: SaaS-2 (profiles/saas2.yaml)
    └── product: SaaS-3 (profiles/saas3.yaml)
```

```sql
-- プロダクトテーブル
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    profile_yaml TEXT NOT NULL,           -- プロファイルの中身（YAML）
    status TEXT DEFAULT 'active',
    analyzed_at TIMESTAMPTZ,              -- 最後のコードベース分析日時
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(tenant_id, name)
);

-- チケットにproduct_id追加
ALTER TABLE tickets ADD COLUMN product_id UUID REFERENCES products(id);

-- 知識はプロダクトごとに分離
-- knowledge_nodes.project_id → products.id に紐付け
```

---

## 6. 汎用Collectorの設計

特定サービスに依存しないCollectorの設計パターン。

```python
# piece/adapters/collectors/generic_api.py

class GenericAPICollector:
    """
    任意のREST APIからデータを収集する汎用Collector。
    Profileの connections 設定で接続先を動的に決定。

    対応: Sentry, Datadog, PagerDuty, Jira, Slack, 独自API...
    """

    implements = CollectorPort

    def __init__(self, config: APIConnectionConfig):
        self.base_url = config.base_url
        self.auth = config.auth  # Bearer, Basic, API Key, etc.
        self.headers = config.headers
        self.response_mapping = config.response_mapping  # JSONパスマッピング

    @property
    def name(self) -> str:
        return f"api:{self.config.name}"

    @property
    def capabilities(self) -> list[str]:
        return self.config.capabilities  # Profile定義から

    async def collect(self, target: Target, query: CollectorQuery) -> Evidence:
        url = self._build_url(query)
        response = await self.client.get(url, headers=self.auth_headers)
        data = self._map_response(response.json())

        return Evidence(
            source=f"api:{self.config.name}:{url}",
            summary=self._summarize(data),
            content=data,
            confidence=Confidence.HIGH,
        )

    def _map_response(self, raw: dict) -> dict:
        """JSONPathマッピングでレスポンスを正規化"""
        result = {}
        for key, path in self.response_mapping.items():
            result[key] = jsonpath(raw, path)
        return result
```

Profile側のAPI接続設定:

```yaml
# profiles/any_saas.yaml

connections:
  custom_apis:
    - name: internal_admin
      base_url: https://admin.example.com/api/v1
      auth:
        type: bearer
        token_ref: vault://example/admin_token
      capabilities: [user_lookup, subscription_status, audit_log]
      endpoints:
        user_lookup:
          method: GET
          path: /users/{user_id}
          response_mapping:
            name: $.data.name
            email: $.data.email
            plan: $.data.subscription.plan
            status: $.data.status
        audit_log:
          method: GET
          path: /audit?user_id={user_id}&since={since}
          response_mapping:
            entries: $.data.entries[*]
            total: $.meta.total
```

---

## 7. 汎用Investigation Playbook

プロダクト固有の調査手順をコードなしで定義できる。

```yaml
# profiles/example.yaml

investigation_playbooks:

  - name: ログインエラー調査
    trigger:
      keywords: [ログイン, login, 認証, パスワード, ロック]
    steps:
      - name: ユーザー状態確認
        tool: db_inspector
        query: "SELECT status, locked_at, failed_attempts FROM users WHERE email = '{customer_email}'"
        interpret:
          locked_at IS NOT NULL: アカウントがロックされている
          failed_attempts >= 5: パスワード5回間違いでロック
          status = 'suspended': アカウントが停止されている

      - name: 認証ログ確認
        tool: structured_log
        query: "service:auth action:login email:{customer_email} @timestamp>[now-24h]"
        interpret:
          count == 0: ログイン試行の記録がない（別のメールアドレスの可能性）
          error contains 'invalid_password': パスワード間違い
          error contains 'account_locked': ロック中にログイン試行

      - name: ブラウザ再現
        tool: browser_prober
        condition: previous_steps.inconclusive  # 前のステップで判明しない場合のみ
        steps:
          - navigate: "{product_url}/login"
          - fill: "#email" with "{customer_email}"
          - fill: "#password" with "test_password_123"
          - click: "#login-button"
          - capture: screenshot + network + console

  - name: データ不整合調査
    trigger:
      keywords: [データ, 消えた, 表示されない, 不整合, 反映されない]
    steps:
      - name: DBレコード確認
        tool: db_inspector
        query: "SELECT * FROM {target_table} WHERE id = '{record_id}'"
        interpret:
          row_count == 0: レコードが存在しない
          deleted_at IS NOT NULL: 論理削除されている
          updated_at < '{reported_time}': 報告時刻以前に最後の更新

      - name: キャッシュ確認
        tool: cache_inspector
        key: "{target_table}:{record_id}"
        interpret:
          exists AND stale: キャッシュに古いデータが残っている
          not_exists: キャッシュミス（DBから再取得されるはず）

      - name: 関連ジョブ確認
        tool: queue_inspector
        queue: "default"
        filter: "class:*{target_table}* AND status:failed"
```

```python
# piece/core/types/playbook.py (Layer 0)

@dataclass
class Playbook:
    name: str
    trigger: PlaybookTrigger
    steps: list[PlaybookStep]

@dataclass
class PlaybookTrigger:
    keywords: list[str]

@dataclass
class PlaybookStep:
    name: str
    tool: str                              # collector/prober名
    query: str | None = None               # テンプレート変数付き
    condition: str | None = None           # 実行条件
    steps: list[dict] | None = None        # ブラウザ操作手順
    interpret: dict[str, str] | None = None  # 結果の解釈ルール


# piece/usecases/investigate.py (Layer 1)

class InvestigateUseCase:

    async def _run_playbook(
        self,
        playbook: Playbook,
        context: dict,           # customer_email, product_url等
    ) -> list[Evidence]:
        """Playbookの各ステップを順に実行"""
        evidences = []
        for step in playbook.steps:
            # 条件チェック
            if step.condition and not self._evaluate_condition(step.condition, evidences):
                continue

            # テンプレート変数を展開
            query = self._render_template(step.query, context) if step.query else None

            # ツール実行
            tool = self.registry.get_by_name(step.tool)
            evidence = await tool.collect_or_probe(query)
            evidences.append(evidence)

            # 結果の自動解釈
            if step.interpret:
                interpretation = self._interpret(evidence, step.interpret)
                if interpretation:
                    evidence.metadata["interpretation"] = interpretation

        return evidences
```

---

## 8. 他のSaaSの例

PIECEが同じコードで全く異なるSaaSに対応できることを示す。

```yaml
# profiles/ec_platform.yaml — ECプラットフォーム
product:
  name: ECショップ管理
  domain: EC・物流
specialists:
  - name: 注文・決済
    keywords: [注文, order, 決済, payment, カート]
  - name: 在庫・出荷
    keywords: [在庫, stock, 出荷, shipping, 配送]
  - name: 商品管理
    keywords: [商品, product, カテゴリ, 画像]
domain_knowledge:
  terminology:
    - term: SKU
      description: 在庫管理単位
    - term: フルフィルメント
      description: 注文から配送までの一連のプロセス
response_style:
  formality: casual
  forbidden_terms:
    バグ: 表示の問題
    エラー: うまく動作しない状態


# profiles/medical_saas.yaml — 医療SaaS
product:
  name: 電子カルテシステム
  domain: 医療
specialists:
  - name: 診療記録
    keywords: [カルテ, 診療, 処方, SOAP]
  - name: レセプト
    keywords: [レセプト, 請求, 点数, 保険]
  - name: 予約管理
    keywords: [予約, 受付, 待ち]
domain_knowledge:
  terminology:
    - term: SOAP
      description: 診療記録の書式（Subjective, Objective, Assessment, Plan）
    - term: レセプト
      description: 診療報酬明細書
  business_rules:
    - rule: 患者データは個人情報保護法に準拠して管理
    - rule: 処方データの改竄は医師法違反
response_style:
  formality: formal
  forbidden_terms:
    バグ: システムの動作に関する問題
    データが消えた: データの表示に関する問題


# profiles/hr_saas.yaml — 人事労務SaaS
product:
  name: 勤怠・給与管理
  domain: 人事労務
specialists:
  - name: 勤怠
    keywords: [打刻, 勤怠, 残業, 有給, 休暇]
  - name: 給与計算
    keywords: [給与, 賞与, 社会保険, 源泉徴収]
  - name: 年末調整
    keywords: [年末調整, 扶養, 控除]
```

**PIECEのコードは一切変更しない。** YAMLを差し替えるだけで全く異なるSaaSに対応。

---

## 9. Profile管理API

```
POST   /api/products                    # プロダクト登録（YAML アップロード）
GET    /api/products                    # プロダクト一覧
GET    /api/products/{id}               # プロダクト詳細
PUT    /api/products/{id}               # プロダクト更新（YAML更新）
DELETE /api/products/{id}               # プロダクト削除
POST   /api/products/{id}/analyze       # コードベース分析実行
GET    /api/products/{id}/specialists   # スペシャリスト一覧
GET    /api/products/{id}/playbooks     # Playbook一覧
POST   /api/products/{id}/test          # Profile接続テスト（全connections疎通確認）
```

---

## 10. 層との対応

```
Profile(YAML) は Layer 0 の型として定義され、
Layer 4 (Entry) で読み込まれ、
Layer 1 (UseCase) に注入される。

Layer 0: ProductProfile型定義（純粋型）
Layer 1: UseCase がprofileを参照してロジック分岐
Layer 2: Port は profile を知らない（汎用インターフェース）
Layer 3: Adapter は connections 設定で接続先を動的決定
Layer 4: Profile読み込み + DI設定

Profile変更時に変わるもの: YAML設定ファイルのみ
Profile変更時に変わらないもの: Layer 0, 1, 2, 3, 4 の全コード
```
