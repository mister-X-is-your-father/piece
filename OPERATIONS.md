# PIECE v2 — 運用設計（Operations Design）

CS担当者・エンジニア・顧客の3者間の実運用フローを設計する。
**CS担当者は「判断しない」「調査しない」「文章を書かない」。リレーするだけ。**

---

## 1. 運用フロー全体像

```
顧客                CS担当者              PIECE                エンジニア
 │                    │                    │                    │
 │── メール送信 ──→   │                    │                    │
 │                    │── チケット作成 ──→  │                    │
 │                    │                    │── ヒアリング質問生成│
 │                    │←─ 追加質問表示 ──  │                    │
 │   ←── メール ────  │                    │                    │
 │                    │                    │                    │
 │── 返信 ────────→   │                    │                    │
 │                    │── 追加情報入力 ──→  │                    │
 │                    │                    │── 調査開始         │
 │                    │                    │   （自律実行）     │
 │                    │                    │── 調査完了         │
 │                    │                    │── FC完了           │
 │                    │                    │── 回答ドラフト生成  │
 │                    │                    │── 8ゲート通過      │
 │                    │                    │                    │
 │                    │                    │── レビュー依頼 ──→ │
 │                    │                    │                    │── レビュー
 │                    │                    │                    │── 承認
 │                    │                    │←─ 承認通知 ──────  │
 │                    │                    │                    │
 │                    │                    │── 顧客向け回答生成  │
 │                    │←─ 回答準備完了 ──  │                    │
 │   ←── メール ────  │  （コピペ送信）    │                    │
 │                    │── 送信完了通知 ──→  │                    │
 │                    │                    │── チケットクローズ  │
```

---

## 2. ロール再設計

### 2.1 4ロール体制

```python
class Role(str, Enum):
    CUSTOMER = "customer"           # 問い合わせする人（実際にはCS経由）
    SUPPORT = "support"             # CS担当者 ★追加
    ENGINEER = "engineer"           # レビュー・承認する人
    ADMIN = "admin"                 # システム管理者
```

| ロール | やること | やらないこと |
|--------|---------|------------|
| **customer** | （直接は使わない。CS担当者が代行入力） | — |
| **support** | チケット作成、追加情報入力、回答メール送信、ステータス確認 | 調査、レビュー、知識DB、スペシャリスト管理 |
| **engineer** | レビュー・承認・修正、知識検索、フィードバック | チケット作成、顧客対応、システム設定 |
| **admin** | 全機能 | — |

### 2.2 API認可マトリクス（更新版）

| エンドポイント | support | engineer | admin |
|---|---|---|---|
| POST /api/tickets | ✅ | — | ✅ |
| GET /api/tickets (担当分) | ✅ | — | — |
| GET /api/tickets (全件) | — | ✅ | ✅ |
| POST /api/tickets/{id}/messages | ✅ | ✅ | ✅ |
| GET /api/tickets/{id}/stream | ✅ | ✅ | ✅ |
| GET /api/tickets/{id}/review | — | ✅ | ✅ |
| POST /api/tickets/{id}/review | — | ✅ | ✅ |
| GET /api/tickets/{id}/customer-response | ✅ | ✅ | ✅ |
| POST /api/tickets/{id}/mark-sent | ✅ | — | ✅ |
| GET /api/knowledge/** | — | ✅ | ✅ |
| POST /api/curiosity/** | — | — | ✅ |
| POST /api/analysis | — | ✅ | ✅ |

---

## 3. チケットステータス再設計

CS運用の実態に合わせる。

```
┌──────────┐    ┌───────────────┐    ┌──────────────┐
│ receiving │───→│ hearing       │───→│ investigating│
│ 受付      │    │ ヒアリング中   │    │ AI調査中     │
└──────────┘    └──────┬────────┘    └──────┬───────┘
                       │                    │
                       ▼                    ▼
                ┌──────────────┐    ┌──────────────┐
                │ waiting_     │    │ fact_checking │
                │ customer     │    │ FC中          │
                │ 顧客返信待ち  │    └──────┬───────┘
                └──────┬───────┘           │
                       │                    ▼
                       │            ┌──────────────┐
                       └──────────→ │ review_      │
                                    │ pending      │
                                    │ レビュー待ち   │
                                    └──────┬───────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │ approved     │
                                    │ 承認済み      │
                                    └──────┬───────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │ ready_to_send│★追加
                                    │ 送信準備完了   │
                                    └──────┬───────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │ sent         │
                                    │ 送信済み      │
                                    └──────┬───────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │ closed       │
                                    │ クローズ      │
                                    └──────────────┘
```

**追加したステータス:**
- `waiting_customer` — CSが顧客に質問を送った後、返信を待っている状態
- `ready_to_send` — エンジニア承認済み + 顧客向け回答文が生成済み。CSがメール送信するだけの状態

```sql
-- ステータスの更新
ALTER TABLE tickets
    DROP CONSTRAINT tickets_status_check,
    ADD CONSTRAINT tickets_status_check CHECK (status IN (
        'receiving',
        'hearing',
        'waiting_customer',    -- ★追加: 顧客の返信待ち
        'investigating',
        'fact_checking',
        'review_pending',
        'approved',
        'ready_to_send',       -- ★追加: CS送信待ち
        'sent',
        'closed'
    ));
```

---

## 4. 顧客向け回答文の生成

### 4.1 2つの回答を生成する

RESPONSE.mdの8ゲートパイプラインの出力は**技術者向け**（citation付き、ファイルパス付き）。
顧客に送るメール文は**別物**。

```
技術者向け回答（FinalResponse）:
  「src/auth/handler.ts:L42 の validatePassword() が bcrypt.compare() を
   呼び出し [source:src/auth/handler.ts:L42]、5回の失敗後に
   accountLockout() [source:src/auth/lockout.ts:L15] がトリガーされ...」

顧客向け回答文（CustomerResponse）:
  「お客様のアカウントは、パスワードの入力ミスが5回に達したため
   一時的にロックされています。

   ■ 解決方法
   1. 管理者にアカウントロック解除を依頼してください
   2. 解除後、パスワードリセットをお勧めします
      → 設定画面 > セキュリティ > パスワード変更

   ■ 補足
   ・ロックは5回の連続失敗で自動的に発動します
   ・30分後に自動解除される設定にもできます（管理者設定）

   ご不明な点がございましたらお気軽にお問い合わせください。」
```

### 4.2 CustomerResponseの型定義

```python
@dataclass
class CustomerResponse:
    """顧客向け回答文（メールに貼り付けるだけの状態）"""
    subject: str                # メール件名
    greeting: str               # 「お問い合わせありがとうございます」
    summary: str                # 結論（1-2文）
    body: str                   # 本文（解決方法、手順等）
    supplement: str             # 補足情報
    closing: str                # 締め（「ご不明な点がございましたら〜」）
    internal_ref: str           # 内部参照ID（チケットID）

    def to_email_text(self) -> str:
        """メールにそのまま貼れるプレーンテキスト"""
        return f"""{self.greeting}

{self.summary}

{self.body}

{self.supplement}

{self.closing}

---
お問い合わせ番号: {self.internal_ref}
"""

    def to_email_html(self) -> str:
        """HTMLメール用"""
        ...
```

### 4.3 顧客向け回答の生成パイプライン

```python
class CustomerResponseGenerator:
    """技術者向け回答を顧客向けに変換する"""

    def __init__(self):
        self.agent = Agent(
            model="claude-sonnet-4-6",
            system_prompt=CUSTOMER_RESPONSE_SYSTEM,
        )

    async def generate(
        self,
        technical_response: FinalResponse,
        ticket: Ticket,
        customer_context: CustomerContext,
    ) -> CustomerResponse:
        result = await self.agent.run(f"""
## 技術者向け回答（内部用）
{technical_response.content}

## 顧客情報
名前: {customer_context.name}
過去の問い合わせ数: {customer_context.ticket_count}
技術レベル: {customer_context.technical_level}

## チケット情報
件名: {ticket.subject}
カテゴリ: {ticket.category}

## 指示
上記の技術者向け回答を、顧客向けのメール文に変換してください。
""")
        return self._parse(result.content)


CUSTOMER_RESPONSE_SYSTEM = """あなたは顧客対応メールの専門家です。
技術者向けの調査報告を、顧客が理解できるメール文に変換します。

ルール:
1. ファイルパス、行番号、関数名などの技術的詳細は全て削除
2. [source:...] 引用は全て削除
3. 顧客が「何をすべきか」を最も目立つ位置に置く
4. 専門用語は平易な言葉に言い換える
5. 丁寧だが簡潔に。冗長な敬語は避ける
6. 「■」「・」で視覚的に整理する
7. 最後に「ご不明な点がございましたら」で締める
8. 確信度が低い情報は「可能性があります」と表現する
   （「未確認」「推測」等の技術用語は使わない）
"""
```

### 4.4 顧客の技術レベルに応じた調整

```python
@dataclass
class CustomerContext:
    name: str
    company: str | None
    ticket_count: int           # 過去の問い合わせ数
    technical_level: str        # "non_technical" | "basic" | "intermediate" | "advanced"

# 技術レベル別の回答スタイル
RESPONSE_STYLES = {
    "non_technical": {
        "use_technical_terms": False,
        "explain_steps_in_detail": True,
        "include_screenshots": True,
        "max_length": 500,
    },
    "basic": {
        "use_technical_terms": False,
        "explain_steps_in_detail": True,
        "include_screenshots": False,
        "max_length": 800,
    },
    "intermediate": {
        "use_technical_terms": True,  # 説明付き
        "explain_steps_in_detail": False,
        "include_screenshots": False,
        "max_length": 1000,
    },
    "advanced": {
        "use_technical_terms": True,
        "explain_steps_in_detail": False,
        "include_screenshots": False,
        "max_length": 1500,
        "include_technical_details": True,  # コード例もOK
    },
}
```

---

## 5. 通知フロー

### 5.1 誰にいつ何を通知するか

| イベント | 通知先 | 通知方法 | 内容 |
|---------|--------|---------|------|
| 新規チケット作成 | CS担当者(自分) | 画面更新 | 「チケット作成しました」 |
| ヒアリング質問生成 | CS担当者 | 画面 + Slack | 「顧客に以下を確認してください: ...」 |
| 顧客への質問タイムアウト | CS担当者 | Slack | 「24時間返信なし。リマインドしますか？」 |
| 調査完了 | — | — | （内部遷移のみ。CSには見せない） |
| FC完了 | — | — | （内部遷移のみ） |
| レビュー依頼 | エンジニア | Slack + メール | 「レビューお願いします: [チケットタイトル]」 |
| エンジニア承認 | CS担当者 | Slack | 「回答準備できました: [チケットタイトル]」 |
| 送信待ち(ready_to_send) | CS担当者 | 画面ハイライト | 「送信待ちが1件あります」 |
| CS送信完了 | エンジニア | — | （ダッシュボードのステータス更新のみ） |
| 3日間未対応 | CS担当者 + 管理者 | Slack | 「対応が遅れています」 |

### 5.2 通知の設計

```python
class NotificationService:
    """通知の送信を管理する"""

    async def notify(self, event: TicketEvent):
        """イベントに応じて適切な相手に通知する"""
        rules = self.get_notification_rules(event.type)

        for rule in rules:
            recipients = await self.resolve_recipients(rule, event)
            for recipient in recipients:
                match rule.channel:
                    case "slack":
                        await self.slack.send(
                            channel=recipient.slack_channel,
                            message=self.format_slack(event, rule.template),
                        )
                    case "email":
                        await self.email.send(
                            to=recipient.email,
                            subject=self.format_subject(event),
                            body=self.format_email(event, rule.template),
                        )
                    case "in_app":
                        await self.push_notification(recipient.user_id, event)

@dataclass
class TicketEvent:
    type: str                    # "hearing_question", "review_request", "approved", etc.
    ticket_id: str
    ticket_subject: str
    data: dict                   # イベント固有データ
    timestamp: datetime

# 通知ルール設定（YAML）
NOTIFICATION_RULES = {
    "hearing_question": {
        "recipients": ["ticket.assigned_support"],
        "channels": ["in_app", "slack"],
        "template": "hearing_question",
        "urgency": "normal",
    },
    "review_request": {
        "recipients": ["engineers.on_duty"],  # 当番エンジニア
        "channels": ["slack", "email"],
        "template": "review_request",
        "urgency": "high",
    },
    "approved": {
        "recipients": ["ticket.assigned_support"],
        "channels": ["in_app", "slack"],
        "template": "response_ready",
        "urgency": "high",
    },
    "stale_ticket": {
        "recipients": ["ticket.assigned_support", "admins"],
        "channels": ["slack"],
        "template": "stale_warning",
        "urgency": "high",
        "condition": "ticket.age > 3 days AND ticket.status NOT IN ('sent', 'closed')",
    },
}
```

---

## 6. CS担当者の画面設計

### 6.1 CS担当者ダッシュボード

```
┌─────────────────────────────────────────────────────────┐
│  PIECE サポートダッシュボード        [山田太郎] [ログアウト] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [対応中: 3件]  [送信待ち: 1件🔴]  [顧客返信待ち: 2件]  [完了: 15件] │
│                                                         │
│  ─── 送信待ち（最優先） ───────────────────────────────── │
│  🔴 #1042 ログインできない (株式会社A)  承認済み 2分前     │
│     → [回答を確認して送信]                                │
│                                                         │
│  ─── 対応中 ──────────────────────────────────────────── │
│  🟡 #1045 エラーが出る (株式会社B)      AI調査中 5分前     │
│  🟡 #1044 画面が表示されない (C社)      レビュー中 30分前   │
│  🟡 #1043 データが消えた (D社)          ヒアリング中        │
│     → PIECEからの質問: 「削除操作をされましたか？」        │
│     → [顧客に質問を送る]                                 │
│                                                         │
│  ─── 顧客返信待ち ────────────────────────────────────── │
│  ⚪ #1041 帳票が出力できない (E社)      質問送信済み 1日前  │
│     → [リマインドを送る]                                 │
│  ⚪ #1040 連携エラー (F社)              質問送信済み 3時間前│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 6.2 チケット詳細画面（CS用）

```
┌─────────────────────────────────────────────────────────┐
│  #1042 ログインできない                     ステータス: 送信待ち │
├──────────────────┬──────────────────────────────────────┤
│  左カラム         │  右カラム                             │
│                  │                                      │
│  ■ 問い合わせ内容│  ■ 顧客向け回答文（そのままコピペ可）   │
│  「ログインでき  │  ┌────────────────────────────────┐  │
│   ません。       │  │お問い合わせありがとうございます。  │  │
│   パスワードは   │  │                                │  │
│   合ってるはず」│  │お客様のアカウントは、パスワード  │  │
│                  │  │の入力ミスが5回に達したため      │  │
│  ■ ヒアリング    │  │一時的にロックされています。      │  │
│  AI: OS は？     │  │                                │  │
│  顧客: Win11     │  │■ 解決方法                      │  │
│  AI: ブラウザは？│  │1. 管理者にロック解除を依頼      │  │
│  顧客: Chrome    │  │2. 解除後、パスワードリセット    │  │
│                  │  │                                │  │
│  ■ 調査サマリー  │  │■ 補足                          │  │
│  確信度: 高      │  │・ロックは5回失敗で自動発動      │  │
│  検証: 3/3       │  │・30分で自動解除も設定可能       │  │
│                  │  │                                │  │
│  ■ 確認ポイント  │  │ご不明な点がございましたら...    │  │
│  ✅ 全て確認済み │  └────────────────────────────────┘  │
│  (エンジニア承認)│                                      │
│                  │  [📋コピー]  [✉️メールで送信]  [✏️編集] │
│                  │                                      │
└──────────────────┴──────────────────────────────────────┘
```

### 6.3 CS担当者の操作（全5つだけ）

```
CS担当者ができること:
  1. [新規チケット作成]   → 顧客情報 + 問い合わせ内容を入力
  2. [追加情報を入力]     → 顧客から聞いた情報をチケットに追加
  3. [顧客に質問を送る]   → PIECEが生成した質問をメールにコピペ
  4. [回答をコピー/送信]  → 承認済みの顧客向け回答をメールに貼り付け
  5. [送信完了を報告]     → チケットをsent状態にする

CS担当者ができないこと:
  ❌ 調査内容を見る（技術的詳細は不要）
  ❌ エンジニアのレビューに関与する
  ❌ 回答を自分で書く/編集する（コピペのみ）
  ❌ 知識DBを検索する
  ❌ 分析を実行する
```

---

## 7. メール連携

### 7.1 パターン

```
パターンA: 完全手動（MVP）
  CS担当者が自分でメール作成 → PIECEの文をコピペ → 送信
  → 最もシンプル。PIECEはメール機能を持たない。

パターンB: 半自動（推奨）
  PIECEが「メールドラフト」を生成 → CS担当者がワンクリックでメーラー起動
  → mailto: リンク or Gmail API でドラフト作成

パターンC: 全自動（将来）
  PIECEがメールを直接送信 → CS担当者は送信前に確認するだけ
  → SendGrid / SES 連携
```

### 7.2 半自動パターンの設計

```python
# piece/api/routes/tickets.py

@router.get("/api/tickets/{id}/email-draft")
async def get_email_draft(
    id: str,
    auth: AuthContext = Depends(require_role(Role.SUPPORT)),
) -> EmailDraft:
    """CS担当者向け: コピペ用のメール文を返す"""
    ticket = await ticket_service.get(id)
    customer_response = await response_service.get_customer_response(id)

    return EmailDraft(
        to=ticket.customer_email,
        subject=f"Re: {ticket.subject} [#{ticket.id[:8]}]",
        body=customer_response.to_email_text(),
        mailto_link=build_mailto_link(ticket, customer_response),
    )


@dataclass
class EmailDraft:
    to: str
    subject: str
    body: str
    mailto_link: str      # mailto:xx?subject=xx&body=xx（ワンクリック起動）
```

---

## 8. SLA・タイムアウト設計

```yaml
sla:
  # ヒアリング
  hearing_max_questions: 5       # 最大質問回数（それ以上は調査開始）
  hearing_question_timeout: 24h  # 顧客の返信がなければリマインド

  # 調査
  investigation_timeout: 30m     # 30分以内に調査完了（タイムアウト→エスカレーション）

  # レビュー
  review_timeout: 2h             # エンジニアが2時間以内にレビュー
  review_escalation: 4h          # 4時間放置で管理者にエスカレーション

  # 送信
  send_timeout: 1h               # 承認後1時間以内にCS送信（リマインド）

  # 全体
  total_target: 4h               # 受付からsent まで4時間以内が目標
  total_max: 24h                 # 24時間超過で管理者アラート
```

```python
class SLAMonitor:
    """SLA遵守を監視し、タイムアウトで通知する"""

    async def check_all_tickets(self):
        """定期実行（5分ごと）"""
        tickets = await ticket_service.get_active_tickets()

        for ticket in tickets:
            violations = self.check_sla(ticket)
            for violation in violations:
                await notification_service.notify(TicketEvent(
                    type=violation.event_type,
                    ticket_id=ticket.id,
                    ticket_subject=ticket.subject,
                    data={"violation": violation.description},
                ))

    def check_sla(self, ticket: Ticket) -> list[SLAViolation]:
        violations = []
        now = datetime.now()
        age = now - ticket.created_at

        # ステータス別チェック
        match ticket.status:
            case "waiting_customer":
                wait_time = now - ticket.last_question_at
                if wait_time > timedelta(hours=24):
                    violations.append(SLAViolation(
                        event_type="customer_timeout",
                        description=f"顧客返信待ち{wait_time.days}日",
                    ))
            case "review_pending":
                wait_time = now - ticket.review_requested_at
                if wait_time > timedelta(hours=4):
                    violations.append(SLAViolation(
                        event_type="review_escalation",
                        description=f"レビュー待ち{wait_time.hours}時間",
                    ))
            case "ready_to_send":
                wait_time = now - ticket.approved_at
                if wait_time > timedelta(hours=1):
                    violations.append(SLAViolation(
                        event_type="send_reminder",
                        description="承認済み回答の送信が1時間遅延",
                    ))

        # 全体SLA
        if age > timedelta(hours=24) and ticket.status != "closed":
            violations.append(SLAViolation(
                event_type="total_sla_breach",
                description=f"受付から{age.days}日{age.seconds//3600}時間経過",
            ))

        return violations
```

---

## 9. DBスキーマ追加

DATA_SECURITY.mdに追記すべき変更:

```sql
-- users テーブルにrole追加
ALTER TABLE users
    DROP CONSTRAINT users_role_check,
    ADD CONSTRAINT users_role_check
        CHECK (role IN ('customer', 'support', 'engineer', 'admin'));

-- tickets テーブルにステータス追加 + CS担当者
ALTER TABLE tickets
    ADD COLUMN assigned_support_id UUID REFERENCES users(id),
    ADD COLUMN last_question_at TIMESTAMPTZ,
    ADD COLUMN review_requested_at TIMESTAMPTZ,
    DROP CONSTRAINT tickets_status_check,
    ADD CONSTRAINT tickets_status_check CHECK (status IN (
        'receiving', 'hearing', 'waiting_customer',
        'investigating', 'fact_checking', 'review_pending',
        'approved', 'ready_to_send', 'sent', 'closed'
    ));

-- 顧客向け回答文テーブル
CREATE TABLE customer_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    greeting TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    supplement TEXT,
    closing TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 通知履歴テーブル
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    recipient_id UUID NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL,
    ticket_id UUID REFERENCES tickets(id),
    channel TEXT NOT NULL,           -- slack / email / in_app
    content TEXT NOT NULL,
    read_at TIMESTAMPTZ,             -- 既読管理
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, read_at);

-- 顧客コンテキスト（回答スタイル調整用）
CREATE TABLE customer_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID REFERENCES users(id),
    name TEXT NOT NULL,
    company TEXT,
    email TEXT NOT NULL,
    technical_level TEXT DEFAULT 'basic'
        CHECK (technical_level IN ('non_technical', 'basic', 'intermediate', 'advanced')),
    ticket_count INTEGER DEFAULT 0,
    notes TEXT,                      -- CS担当者のメモ
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 10. チェックリスト: 設計の穴

| # | 項目 | 状態 | 設計書 |
|---|------|------|--------|
| 1 | CS担当者ロール | ✅ 今回追加 | OPERATIONS.md |
| 2 | CS→顧客の通知経路 | ✅ 今回追加 | OPERATIONS.md §5,7 |
| 3 | 顧客向け回答文の生成 | ✅ 今回追加 | OPERATIONS.md §4 |
| 4 | CS担当者の画面設計 | ✅ 今回追加 | OPERATIONS.md §6 |
| 5 | 通知フロー | ✅ 今回追加 | OPERATIONS.md §5 |
| 6 | CS運用に合ったステータス | ✅ 今回追加 | OPERATIONS.md §3 |
| 7 | SLA・タイムアウト | ✅ 今回追加 | OPERATIONS.md §8 |
| 8 | 顧客プロフィール（技術レベル） | ✅ 今回追加 | OPERATIONS.md §4.4 |
| 9 | メール連携 | ✅ 今回追加（半自動） | OPERATIONS.md §7 |
| 10 | CS操作の制限 | ✅ 今回追加（5操作のみ） | OPERATIONS.md §6.3 |
