# PIECE v2 — Distribution Design（配布・知財保護設計）

**SaaSモデルで両方を守る。** ソースコードも顧客データも。

---

## 1. 結論

```
ソースコード保護: SaaSだから解決。渡さない。
顧客データ保護: 信頼基盤で解決。暗号化 + 顧客管理 + 監査。

PIECEは全てクラウドで動く。
顧客にインストールさせるものはない。
ソースコードは一切外に出ない。
顧客データは暗号化+分離+顧客が完全に制御。
```

---

## 2. 標準アーキテクチャ（SaaS）

```
┌──── PIECEクラウド ──────────────────────────────────────┐
│                                                         │
│  ┌── テナントA ──────┐  ┌── テナントB ──────┐          │
│  │ [AES-256暗号化]    │  │ [AES-256暗号化]    │  完全分離│
│  │                    │  │                    │          │
│  │ 知識DB             │  │ 知識DB             │          │
│  │ チケット           │  │ チケット           │          │
│  │ 調査結果           │  │ 調査結果           │          │
│  │ 回答履歴           │  │ 回答履歴           │          │
│  └────────────────────┘  └────────────────────┘          │
│                                                         │
│  PIECE Brain + Agent 全てここ                           │
│  ソースコード = クラウド上のみ                            │
│                                                         │
│  外部接続:                                               │
│    GitHub/GitLab → OAuth連携（コードを参照）              │
│    Datadog/Sentry → APIキー（ログ・エラーを参照）         │
│    顧客DB → 読み取り専用接続（暗号化通信）                │
│    顧客ステージング → HTTPS（ブラウザ操作）               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 顧客データ保護の仕組み

### 3.1 暗号化

```
保存時（at rest）:
  全データ AES-256-GCM で暗号化
  暗号化鍵は顧客ごとに異なる（テナント別鍵）

通信時（in transit）:
  全通信 TLS 1.3
  顧客DB接続も SSL required（verify-full）

BYOK（Bring Your Own Key）:
  顧客が自分のKMS鍵を提供可能（エンタープライズ）
  PIECEのオペレータでも復号不可能
  顧客が鍵を無効化 = 全データ即時アクセス不能
```

### 3.2 テナント分離

```sql
-- PostgreSQL Row Level Security
-- アプリにバグがあっても、他テナントのデータは物理的に見えない

ALTER TABLE knowledge_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON knowledge_nodes
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- 全テーブルに同様のポリシー適用
```

### 3.3 データスコープ制御

顧客が「PIECEに何を見せるか」を細かく制御。

```yaml
# 顧客が設定する
data_scope:
  code:
    repositories: [repo-a, repo-b]      # この2つだけ許可
    exclude_paths:                        # これは絶対に見せない
      - "**/.env*"
      - "**/secrets/**"
      - "**/credentials/**"

  logs:
    services: [api-server, worker]       # このサービスのログだけ
    mask_fields: [email, phone, ip_address, credit_card]

  database:
    tables: [users, orders, products]    # このテーブルだけ
    mask_columns:                         # この列はマスク
      users: [password_hash, ssn, phone]
      orders: [credit_card_number]
    readonly: true                        # 書き込み不可（強制）

  environments:
    allow_staging: true                   # ステージングはOK
    allow_production: false               # 本番は禁止
```

```python
# piece/adapters/security/data_scope.py

class DataScopeEnforcer:
    """データスコープを強制する。設定外のデータにはアクセス不能。"""

    async def filter_file_access(self, path: str, scope: DataScope) -> bool:
        """このファイルにアクセスしていいか"""
        if any(fnmatch(path, pattern) for pattern in scope.code.exclude_paths):
            return False  # 禁止パスに一致
        return True

    async def mask_db_result(self, table: str, row: dict, scope: DataScope) -> dict:
        """DBの結果からマスク対象列を隠す"""
        masked_cols = scope.database.mask_columns.get(table, [])
        return {
            k: "***MASKED***" if k in masked_cols else v
            for k, v in row.items()
        }

    async def mask_log_entry(self, entry: str, scope: DataScope) -> str:
        """ログからマスク対象フィールドを隠す"""
        for field in scope.logs.mask_fields:
            entry = re.sub(
                rf'"{field}"\s*:\s*"[^"]*"',
                f'"{field}": "***"',
                entry,
            )
        return entry
```

### 3.4 監査ログ（顧客に全公開）

```
顧客はPIECEが自分のデータに何をしたかをリアルタイムで確認可能。

GET /api/audit

[
  {"time": "10:15:03", "action": "read_file", "target": "src/auth/handler.ts:40-60", "agent": "specialist:auth"},
  {"time": "10:15:05", "action": "query_db", "target": "users WHERE email=***", "agent": "specialist:auth"},
  {"time": "10:15:08", "action": "search_log", "target": "service:auth level:error", "agent": "specialist:auth"},
  {"time": "10:15:10", "action": "browser_open", "target": "https://staging.example.com/login", "agent": "rpa:browser"},
]

全操作が記録される。隠し事はゼロ。
```

### 3.5 データ保持・削除

```
顧客が制御:
  チケット保持期間: 30日 / 90日 / 180日 / 365日 / 無制限（選択）
  知識DB保持期間: 無制限（推奨） / カスタム
  監査ログ保持期間: 365日（最低、法令遵守）

データ削除:
  DELETE /api/tenant/data
  → 全データ即時削除（暗号化鍵の破棄で物理削除と同等）
  → 削除証明書を発行

データエクスポート:
  GET /api/tenant/export
  → 顧客の全データをJSON/CSVでダウンロード可能（ポータビリティ権）
```

---

## 4. ソースコード保護

```
SaaSモデルなので、保護は自動的に成立する。

顧客に渡るもの:
  ✅ Web UI（Next.js — フロントエンドのみ）
  ✅ API仕様（OpenAPI — エンドポイントの契約だけ）
  ✅ Product Profile仕様（YAML — 設定方法の文書）

顧客に渡らないもの:
  ❌ Python ソースコード
  ❌ アルゴリズム（検索、好奇心、ファクトチェック）
  ❌ プロンプト（スペシャリスト、回答生成、品質ゲート）
  ❌ DBスキーマの詳細
  ❌ 内部アーキテクチャ

追加保護:
  ソースコードはGitHubのprivateリポジトリ
  デプロイはCI/CD（人間がサーバーにSSHしない）
  社内アクセスもRBACで制限（開発者以外はコードを見れない）
```

---

## 5. 顧客の接続方法

### 5.1 初期セットアップ（5ステップ）

```
1. PIECEにサインアップ
   → メール認証 → テナント作成

2. Product Profile を作成
   → 管理画面でウィザード形式
   → プロダクト名、ドメイン、スペシャリスト定義

3. コードベースを接続
   → GitHub OAuth で「Install PIECE App」
   → リポジトリを選択（全部でなくていい）

4. 監視ツールを接続
   → Datadog APIキーを入力（または Sentry / CloudWatch）

5. 分析を実行
   → ボタン1つでコードベース分析開始
   → 完了後、即座にaskが使える
```

### 5.2 セキュリティ設定（オプション）

```
6. データスコープ設定
   → 何を見せるか細かく制御（YAML or 管理画面）

7. BYOK設定（エンタープライズ）
   → AWS KMSのARNを入力 → PIECE が顧客の鍵で暗号化

8. IP制限
   → PIECEへのアクセスを特定IPからのみ許可

9. SSO設定
   → SAML / OIDC で企業の認証基盤と統合
```

---

## 6. プラン設計

| | Starter | Pro | Business | Enterprise |
|---|---|---|---|---|
| 月額 | ¥50,000 | ¥150,000 | ¥300,000 | 要相談 |
| プロダクト数 | 1 | 3 | 10 | 無制限 |
| チケット/月 | 100 | 500 | 無制限 | 無制限 |
| スペシャリスト数 | 5 | 20 | 50 | 無制限 |
| ユーザー数 | 3 | 10 | 30 | 無制限 |
| データ保持 | 90日 | 180日 | 365日 | カスタム |
| BYOK | — | — | ✅ | ✅ |
| SSO | — | — | ✅ | ✅ |
| 専用インスタンス | — | — | — | ✅ |
| SLA保証 | — | 99.9% | 99.9% | 99.99% |
| 好奇心探索 | — | ✅ | ✅ | ✅ |
| RPA（ブラウザ操作） | — | ✅ | ✅ | ✅ |

---

## 7. エンタープライズオプション

99%の顧客はSaaSで十分。残り1%向け。

```
Option 1: 専用インスタンス
  → 顧客専用のPIECEをAWSに立てる
  → 他テナントと物理的に完全分離
  → 料金: Business × 3〜

Option 2: VPC内デプロイ
  → 顧客のAWS VPC内にPIECEをデプロイ
  → データが顧客のAWSアカウントから一切出ない
  → PIECEのコードはDockerイメージ（コンパイル済み）で提供
  → 料金: Business × 5〜

Option 3: Confidential Computing
  → AWS Nitro Enclaves で実行
  → メモリ上のデータすら暗号化
  → 顧客がattestation（暗号学的証明）で「承認されたコードのみ動作」を検証可能
  → PIECEオペレータもAWSも顧客データを見れない
  → 料金: 要相談
```

---

## 8. コードベースの規模感

```
現在（v1 TypeScript）:
  73ファイル / 14,693行

  knowledge/  6,525行 (44%)  ← 知識エンジン（核心）
  agents/     3,378行 (23%)  ← エージェント制御
  commands/   1,735行 (12%)  ← CLIコマンド
  analyzer/   1,109行 (8%)   ← コード分析
  その他      1,946行 (13%)

Python v2 予測:
  Layer 0 (Core):    ~3,000行  ← アルゴリズムは移植
  Layer 1 (UseCases): ~2,000行
  Layer 2 (Ports):    ~500行   ← インターフェースのみ
  Layer 3 (Adapters): ~5,000行 ← ライブラリ呼び出しが多い
  Layer 4 (Entry):    ~2,000行
  合計: ~12,500行

  v1より小さくなる理由:
    agent-runner.ts (150行) → Agent SDK (0行)
    自前LSH-ANN (50行) → FAISS (呼び出しのみ)
    自前N-gram (100行) → MeCab (呼び出しのみ)
    CLIコマンド (1,735行) → Typer + FastAPI で削減

Dockerイメージサイズ:
  Python 3.12-slim base: ~150MB
  依存ライブラリ: ~500MB (FAISS, MeCab, Playwright等)
  PIECEコード: ~5MB
  合計: ~650MB（圧縮後 ~300MB）
```

---

## 9. 層との対応

```
LAYERS.md の全層がクラウドで動く:

  Layer 0 (Core)      → クラウド
  Layer 1 (UseCases)  → クラウド
  Layer 2 (Ports)     → クラウド
  Layer 3 (Adapters)  → クラウド
  Layer 4 (Entry)     → クラウド

顧客側に配置するものはゼロ。

接続:
  顧客のGitHub → PIECEクラウドがOAuth経由でAPI呼び出し
  顧客のDatadog → PIECEクラウドがAPIキーで呼び出し
  顧客のDB → PIECEクラウドがSSL接続（読み取り専用）
  顧客のステージング → PIECEクラウドのPlaywrightがHTTPSアクセス
```
