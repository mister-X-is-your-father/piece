# PIECE v2 — Distribution & IP Protection（配布・知財保護設計）

PIECEをサービスとして提供する際に、
**ソースコードを守りつつ、顧客のデータも守る**ための設計。

---

## 1. ハイブリッド配布モデル

```
┌──── こちらのクラウド（ソース保護） ──────────────────┐
│                                                     │
│  ┌─────────────────────────────────────────┐       │
│  │          PIECE Brain（知能）             │       │
│  │                                         │       │
│  │  ・AI判断ロジック                        │       │
│  │  ・回答生成パイプライン（8ゲート）         │       │
│  │  ・好奇心探索エンジン                    │       │
│  │  ・ファクトチェックロジック               │       │
│  │  ・検索アルゴリズム（Synapse v2）         │       │
│  │  ・Profile解釈エンジン                   │       │
│  │  ・回答品質スコアリング                   │       │
│  │                                         │       │
│  │  → ソースコードは一切外に出ない           │       │
│  └──────────────────┬──────────────────────┘       │
│                      │ 暗号化API（TLS 1.3）        │
└──────────────────────┼──────────────────────────────┘
                       │
           ── 境界（Secure Tunnel）──
                       │
┌──── 顧客のネットワーク（データ保護） ──────────────────┐
│                      │                               │
│  ┌──────────────────┴──────────────────────┐       │
│  │          PIECE Agent（手足）              │       │
│  │                                         │       │
│  │  ・ソースコード読み取り                   │       │
│  │  ・ログ収集                              │       │
│  │  ・DB読み取り（SELECT only）              │       │
│  │  ・ブラウザ操作（Playwright）             │       │
│  │  ・SSH接続                               │       │
│  │                                         │       │
│  │  → 顧客のデータは一切外に出ない           │       │
│  │  → 収集したデータはBrainに要約だけ送る    │       │
│  └─────────────────────────────────────────┘       │
│                                                     │
│  顧客のシステム: DB, サーバー, アプリ, ログ          │
└─────────────────────────────────────────────────────┘
```

**核心:**
- **Brain（知能）はクラウドに残る。** ソースコードは顧客に渡らない
- **Agent（手足）は顧客のネットワークで動く。** データは外に出ない
- **AgentがBrainに送るのは「要約」だけ。** 生データは送らない

---

## 2. 何をどこに置くか

### Brain（クラウド側） — 知財の核心

```
こちらが持つもの（ソース非公開）:
  ├── Core Domain（Layer 0）     → 全アルゴリズム
  ├── Use Cases（Layer 1）       → 全ビジネスロジック
  ├── Ports（Layer 2）           → インターフェース定義
  ├── AI Adapters（Layer 3一部） → AI呼び出し、回答生成
  ├── Response Pipeline          → 8ゲート品質パイプライン
  ├── Curiosity Engine           → 好奇心探索
  ├── Search Engine              → Synapse v2
  └── Knowledge Store            → 知識DB（テナント別、クラウド上）
```

### Agent（顧客側） — 最小限のクライアント

```
顧客に渡すもの（IP価値が低い、または保護済み）:
  ├── Agent Binary               → コンパイル済みバイナリ（ソースなし）
  ├── Collectors                  → データ収集の薄いラッパー
  ├── Probers                    → ブラウザ操作、API呼び出し
  ├── Secure Tunnel Client       → Brain接続用の暗号化トンネル
  └── Profile（YAML）            → 顧客自身が作成する設定
```

---

## 3. Agent（顧客配布物）の保護

### 3.1 コンパイル済みバイナリ配布

Pythonソースを配布しない。コンパイルしたバイナリを渡す。

```
ビルドパイプライン:
  Python source → Nuitka (AOTコンパイラ) → ネイティブバイナリ

  piece-agent-linux-x86_64    ← Linux用
  piece-agent-linux-arm64     ← ARM用
  piece-agent-darwin-x86_64   ← macOS Intel
  piece-agent-darwin-arm64    ← macOS Apple Silicon
```

```
Nuitkaの利点:
  - Pythonソースを完全にC言語にトランスパイル→コンパイル
  - 逆コンパイルが極めて困難（CPython bytecodeより遥かに難しい）
  - 依存ライブラリも含めて単一バイナリに
  - 実行速度も向上
```

```bash
# ビルド
nuitka --standalone --onefile \
  --include-package=piece.agent \
  --output-filename=piece-agent \
  piece/agent/main.py
```

### 3.2 Docker配布（代替）

```dockerfile
# Dockerfile.agent
FROM python:3.12-slim AS builder
# ソースをコピーしてコンパイル
COPY piece/agent/ /build/
RUN nuitka --standalone /build/main.py

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /build/main.dist/ /app/
ENTRYPOINT ["/app/main"]
```

```
Dockerの利点:
  - distrolessイメージ → シェルすらない。中に入れない
  - マルチステージビルド → ソースはbuilderステージにしかない
  - 最終イメージにはバイナリだけ

Dockerの限界:
  - 層を展開すればバイナリは取り出せる
  - ただしコンパイル済みなので逆アセンブルは困難
```

### 3.3 ライセンス認証

Agentは起動時にBrainに認証する。認証が通らなければ動かない。

```python
# piece/agent/license.py

class LicenseValidator:
    """
    Agentの起動時にBrainにライセンス認証する。
    認証が通らなければAgentは動作しない。
    """

    async def validate(self, license_key: str) -> LicenseInfo:
        response = await self.brain_client.post(
            "/api/license/validate",
            json={
                "license_key": license_key,
                "agent_id": self.agent_id,
                "machine_fingerprint": self._get_fingerprint(),
                "timestamp": datetime.now().isoformat(),
            },
        )

        if response.status_code != 200:
            raise LicenseError("ライセンス認証失敗")

        info = LicenseInfo(**response.json())

        # 有効期限チェック
        if info.expires_at < datetime.now():
            raise LicenseError("ライセンス期限切れ")

        # 同時接続数チェック
        if info.active_agents >= info.max_agents:
            raise LicenseError("同時接続数上限")

        return info

    def _get_fingerprint(self) -> str:
        """マシン固有ID（MACアドレス + CPU ID + ディスクシリアル）"""
        ...


# 定期的に再認証（1時間ごと）
# Brain側でライセンスを無効化すれば、Agent は1時間以内に停止
```

---

## 4. Brain ↔ Agent 通信プロトコル

### 4.1 データの分離原則

```
Agent → Brain に送るもの:
  ✅ 要約・メタデータ（ファイル名、関数名、エラーメッセージ）
  ✅ 構造化された調査結果（JSON）
  ✅ スクリーンショット（RPA結果）
  ❌ ソースコードの全文は送らない
  ❌ DBの生データは送らない
  ❌ 顧客の個人情報は送らない

Brain → Agent に送るもの:
  ✅ 調査指示（「このファイルのL42-L60を読め」）
  ✅ ヒアリング質問
  ✅ Playbook実行指示
  ❌ Brain内部のアルゴリズムは送らない
  ❌ 他テナントのデータは送らない
```

### 4.2 通信インターフェース

```python
# piece/agent/protocol.py

class BrainProtocol:
    """Agent→Brain通信の定義"""

    # Agent → Brain（調査結果を報告）
    async def report_investigation(
        self,
        ticket_id: str,
        findings: list[Finding],        # 要約された調査結果
    ) -> InvestigationDirective:        # 次の指示
        ...

    # Agent → Brain（証拠を報告）
    async def report_evidence(
        self,
        ticket_id: str,
        evidence: EvidenceSummary,       # 要約。生データではない
    ) -> None:
        ...

    # Brain → Agent（調査指示）
    async def get_directive(
        self,
        ticket_id: str,
    ) -> AgentDirective:
        """Brainからの指示を取得"""
        ...

    # Brain → Agent（Playbook実行指示）
    async def get_playbook_steps(
        self,
        ticket_id: str,
        playbook_name: str,
    ) -> list[PlaybookStep]:
        ...


@dataclass
class Finding:
    """要約された調査結果（生データではない）"""
    type: str                    # "file_content", "log_entry", "db_state", etc.
    summary: str                 # 1行要約
    details: dict                # 構造化された詳細（必要最小限）
    confidence: Confidence
    source: str                  # どこから取得したか

@dataclass
class EvidenceSummary:
    """証拠の要約（生データは含まない）"""
    source_type: str
    summary: str
    key_facts: list[str]         # 重要な事実だけ
    screenshot_url: str | None   # スクショはセキュアストレージにアップ
    confidence: Confidence

@dataclass
class AgentDirective:
    """Brainからの指示"""
    action: str                  # "read_file", "query_db", "probe_api", etc.
    params: dict                 # アクション固有のパラメータ
    scope: str                   # "summary_only" | "full_content"（何を返すか）
```

### 4.3 データ最小化の例

```
ケース: 「src/auth/handler.ts のL42-60を確認して」

Agent側:
  1. ファイルを読む（顧客のサーバー上で）
  2. 該当範囲のコードを取得
  3. Brain に送る:
     - scope="summary_only" の場合:
       「validatePassword関数が存在。bcrypt.compareを呼んでいる。
        引数: (inputPassword, hashedPassword)。戻り値: boolean」
     - scope="full_content" の場合:
       コードスニペットをそのまま送る（※設定で許可された場合のみ）

Brain側:
  受け取った要約/コードから判断・回答を生成

顧客側の設定で制御:
  data_policy:
    allow_code_transfer: false       # コード全文の送信を禁止
    allow_log_transfer: false        # ログ全文の送信を禁止
    allow_screenshot_transfer: true  # スクショは許可
    summary_only: true               # 要約のみ送信
```

---

## 5. Secure Tunnel（安全な接続）

```
Agent ←→ Brain の接続方式:

Option A: WireGuard VPN
  - Agent起動時にWireGuardトンネルを確立
  - Brain APIはVPN内部IPのみ公開
  - 外部からBrain APIに到達不能

Option B: mTLS + WebSocket
  - 相互TLS認証
  - WebSocketで常時接続
  - Agent証明書はライセンス認証時に発行

Option C: SSH Reverse Tunnel（最もシンプル）
  - Agentがoutbound SSHでBrainに接続
  - ファイアウォールで inbound を開ける必要なし
  - 顧客ネットワークのセキュリティポリシーに優しい

推奨: Option B（mTLS + WebSocket）
  理由: 双方向通信、証明書ベース認証、ファイアウォール穴不要
```

```python
# piece/agent/tunnel.py

class SecureTunnel:
    """Brain への安全な接続"""

    async def connect(self, config: TunnelConfig) -> Connection:
        # mTLS証明書をロード（ライセンス認証時に取得済み）
        ssl_context = ssl.create_default_context()
        ssl_context.load_cert_chain(
            certfile=config.client_cert,
            keyfile=config.client_key,
        )
        ssl_context.load_verify_locations(config.ca_cert)

        # WebSocket接続
        ws = await websockets.connect(
            config.brain_url,
            ssl=ssl_context,
            extra_headers={"X-License-Key": config.license_key},
        )

        return Connection(ws)
```

---

## 6. 料金モデル

```
SaaS料金（Brain利用料）:
  ├── Starter:  ¥50,000/月  — 1プロダクト, 100チケット/月, Agent 1台
  ├── Pro:      ¥150,000/月 — 3プロダクト, 500チケット/月, Agent 3台
  ├── Business: ¥300,000/月 — 10プロダクト, 無制限, Agent 10台
  └── Enterprise: 要相談    — カスタム, SLA保証, 専用Brain

Agent（顧客側）:
  → 無料。Agent自体に価値はない。Brainがないと動かない。

従量課金（オプション）:
  AI呼び出し: ¥10/回答（Anthropic API費用のパススルー）
  RPA実行: ¥5/回（Playwright実行費用）
  ストレージ: ¥1/GB/月（知識DB）
```

**Agentを無料にする理由:**
- AgentはBrainなしでは動かない（ライセンス認証で制御）
- Agentのソースは保護済み（コンパイル済みバイナリ）
- Agentを広くばらまくことが営業上有利（導入障壁を下げる）
- 収益はBrain利用料で回収

---

## 7. IP保護の多層防御

```
Layer 1: 物理的分離
  → Brain（知能）はクラウドにしかない。顧客のサーバーに存在しない

Layer 2: コンパイル
  → Agent はNuitkaでネイティブバイナリ化。Pythonソースは配布しない

Layer 3: コンテナ化
  → distroless Docker。シェルもない。ファイルを見ることすら困難

Layer 4: ライセンス認証
  → Brainに認証が通らなければAgentは起動しない
  → 認証は1時間ごとに再検証。ライセンス無効化で即停止

Layer 5: 通信暗号化
  → mTLS。盗聴不能。中間者攻撃不能

Layer 6: データ最小化
  → Agentが送るのは要約のみ。ソースコード全文は送らない（設定可能）

Layer 7: 監査
  → Agent↔Brain間の全通信をログ。不正利用の検出
```

---

## 8. 顧客視点のインストール手順

```bash
# 1. Agent をダウンロード（バイナリ or Docker）
curl -L https://piece.example.com/agent/latest/linux-x86_64 -o piece-agent
chmod +x piece-agent

# 2. ライセンスキーを設定
export PIECE_LICENSE_KEY="lic_xxxxxxxxxxxx"
export PIECE_BRAIN_URL="wss://brain.piece.example.com"

# 3. Product Profile を作成（YAML）
vim piece-profile.yaml

# 4. Agent 起動
./piece-agent --profile piece-profile.yaml

# --- Docker の場合 ---
docker run -d \
  -e PIECE_LICENSE_KEY=lic_xxxxxxxxxxxx \
  -e PIECE_BRAIN_URL=wss://brain.piece.example.com \
  -v ./piece-profile.yaml:/etc/piece/profile.yaml \
  --name piece-agent \
  piece/agent:latest
```

**顧客がやること:**
1. ライセンスキーを入れる
2. YAML設定を書く（接続先、スペシャリスト定義）
3. Agent を起動する

**顧客がやらないこと:**
- ソースコードを見る
- Brainを理解する
- データベースを用意する（Brain側にある）
- AIキーを用意する（Brain側にある）

---

## 9. 層との対応

```
LAYERS.md のどこがどっちに行くか:

Brain（クラウド）:
  Layer 0: Core Domain     → 全てBrain
  Layer 1: Use Cases       → 全てBrain
  Layer 2: Ports           → 全てBrain（Agentは参照しない）
  Layer 3: Adapters
    ├── ai/                → Brain（AI呼び出し）
    ├── storage/           → Brain（知識DB）
    ├── search/            → Brain（検索エンジン）
    ├── notifications/     → Brain（Slack/Email送信）
    └── verifiers/         → Brain（ファクトチェック）
  Layer 4: Entry
    ├── api/               → Brain（FastAPI）
    └── cron/              → Brain（好奇心ループ）

Agent（顧客サーバー）:
  Layer 3: Adapters
    ├── collectors/        → Agent（ログ収集、メトリクス取得）
    ├── probers/           → Agent（ブラウザ操作、API呼び出し）
    ├── file_systems/      → Agent（ソースコード読み取り）
    └── ast/               → Agent（AST解析）
  Layer 4: Entry
    └── agent/             → Agent（デーモンプロセス）

分割の原則:
  「データに触るもの」→ Agent（顧客側）
  「判断するもの」→ Brain（クラウド側）
```
