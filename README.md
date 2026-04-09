# PIECE

**Precise Integrated Expert Collaboration Engine**

マルチエージェントでコードベースを深く分析し、ファクトチェック済みの正確な回答を提供する。使うほど賢くなるカスタマーサポート調査ハーネス。

```
顧客「ログインできません」
  → PIECEが自律調査（コード解析、ログ確認、ブラウザ再現）
  → ファクトチェック（3つの証拠で裏付け、確信度HIGH）
  → 回答生成（8つの品質ゲート通過）
  → エンジニア確認（30秒で承認）
  → 顧客向け回答文を自動生成
```

---

## Design Philosophy（設計思想）

### なぜPIECEを作るのか

エンジニアの時間を「調査」から「開発」に取り戻す。

```
Before:
  顧客「エラーが出る」
  → エンジニアがログを見る（15分）
  → コードを追う（30分）
  → 原因特定（15分）
  → 回答を書く（15分）
  → 合計: 75分/件 × エンジニアの時間

After:
  顧客「エラーが出る」
  → PIECEが全部やる（5分）
  → エンジニアは確認して承認（30秒〜3分）
  → 合計: 3分/件 × エンジニアは承認だけ
```

目指すのは**エンジニア1名 + CS担当者1名で1日50件を処理できる体制。**

### 7つの設計原則とその理由

#### 1. 嘘をつかない（Honesty First）

```
なぜ:
  AIの最大の問題は「自信満々に嘘をつく」こと。
  間違った回答を顧客に送ると、信頼が崩壊する。
  「わからない」と言える方が、間違えるより遥かにマシ。

どうやって:
  - 全回答に必ずファクトチェックを実行（Opusが独立検証）
  - 確信度3段階（HIGH/MEDIUM/LOW）+ 具体的なアクション指示
  - 根拠のない主張はconfidenceを下げ、「未確認」と明示
  - False Known（嘘に気づいていない知識）の自動検出
```

#### 2. 脳・手・セッションの3層分離

```
なぜ:
  AIモデルは世代交代する。DBも変わる。ツールも増える。
  全部密結合だと、1つ変えると全部壊れる。

  層を分離すれば:
    Claude → GPT に変えたい → Brain層だけ差し替え
    PostgreSQL → MongoDB に変えたい → Session層だけ差し替え
    新しい調査ツールを追加 → Hands層にAdapter追加

どうやって:
  Layer 0 (Core):    純粋ドメインロジック（依存ゼロ）
  Layer 1 (UseCases): アプリケーションロジック（Port依存のみ）
  Layer 2 (Ports):    抽象インターフェース（契約だけ）
  Layer 3 (Adapters): 技術固有の実装（差し替え可能）
  Layer 4 (Entry):    外部との接点 + 依存注入
```

#### 3. 無知の知（Socratic Principle）

```
なぜ:
  知識には4つの状態がある:
    Known Known     — 知っていて正しい（価値の源泉）
    Known Unknown   — 知らないと知っている（調査で埋められる）
    Unknown Unknown — 知らないことすら知らない（好奇心で発見する）
    False Known     — 知っていると思い込んでいるが間違い（★最も危険）

  4番目のFalse Knownが最大の脅威。
  システムが「自信満々に間違える」原因はここにある。

どうやって:
  - Curiosity Engine が知識の穴を自動検出
  - 矛盾検出が最高優先度（嘘を見つけて消す > 知識を増やす）
  - 5つのシグナルでFalse Knownを炙り出す:
    矛盾、陳腐化、根拠消失、推測マーカー、孤立した高confidence
```

#### 4. 証拠主義（Evidence-Based）

```
なぜ:
  AIの回答は「それっぽい」だけで信頼できない。
  証拠がない回答は推測であり、推測は嘘の入口。

  全ての主張に「なぜそう言えるのか」の根拠が必要。
  根拠はコードの行番号、ログのタイムスタンプ、APIのレスポンス。

どうやって:
  - 28種の証拠収集手段（Collector 15種 + Prober 7種 + Verifier 6種）
  - 全ての主張に [source:file:Lx] 形式の引用を要求
  - プログラム的検証（ファイル存在、行番号実在）+ AI検証の2段階
  - 証拠のないセクションは回答から除外
```

#### 5. 品質ゲート（Quality Gates）

```
なぜ:
  調査がいくら正確でも、回答が雑なら価値がない。
  「正しいが伝わらない」は「間違い」と同じ。

  回答は8つの品質チェックを全て通過しないと顧客に届かない。

どうやって:
  Gate 1: 素材チェック（材料は揃っているか）
  Gate 2: ドラフト生成
  Gate 3: 事実性チェック（嘘がないか）
  Gate 4: 完全性チェック（答えになっているか）
  Gate 5: 誠実性チェック（不確実さを認めているか）
  Gate 6: 可読性チェック（読みやすいか）
  Gate 7: 行動可能性チェック（何をすべきか明確か）
  Gate 8: セキュリティチェック（秘密が漏れていないか）

  FAILした場合は自動修正→再チェック（最大3回）
```

#### 6. サービスに囚われない（Product Agnostic）

```
なぜ:
  PIECEは特定のSaaSのためのツールではない。
  どんなSaaSにも接続できる汎用ハーネスであるべき。

  会計SaaS、ECプラットフォーム、医療システム、人事労務、
  全て同じPIECEのコードで動く。違うのはYAML設定だけ。

どうやって:
  - Product Profile（YAML）でプロダクト固有の情報を注入
    - ドメイン知識（用語、ビジネスルール）
    - コードベース（リポジトリ、言語、フレームワーク）
    - スペシャリスト定義
    - 接続先（監視ツール、ログ、DB）
    - 回答スタイル（敬語レベル、禁止表現）
    - 調査手順（Playbook）
  - PIECEのコード変更ゼロで新しいSaaSに対応
```

#### 7. データもソースも守る（Dual Protection）

```
なぜ:
  PIECEをサービスとして提供するとき、2つを同時に守る必要がある:
    - 顧客のデータ（コード、ログ、DB内容）
    - PIECEのソースコード（アルゴリズム、プロンプト）

どうやって:
  SaaSモデル:
    - ソースコードはクラウドに留まる（渡さない）
    - 顧客データは暗号化 + テナント分離 + 顧客管理
    - BYOK（顧客が自分の暗号化鍵を管理）
    - データスコープ制御（何を見せるか顧客が決める）
    - 監査ログ全公開（PIECEが何をしたか全て見える）
    - SOC2 Type II 認証
```

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│                    Frontend (Next.js)                    │
│         顧客チャット / CSダッシュボード / エンジニアレビュー │
├────────────────────────────────────────────────────────┤
│                    Harness API (FastAPI)                 │
├────────────────────────────────────────────────────────┤
│                                                         │
│  Layer 0: Core Domain ─── 純粋ロジック（依存ゼロ）       │
│    型定義 / ビジネスルール / 品質ゲート / 検索アルゴリズム  │
│    好奇心探索 / 確信度計算 / False Known検出             │
│                                                         │
│  Layer 1: Use Cases ──── アプリケーションロジック          │
│    質問回答 / 調査 / 分析 / 回答生成 / 好奇心ループ       │
│    ヒアリング / レビュー / フィードバック学習              │
│                                                         │
│  Layer 2: Ports ──────── 抽象インターフェース             │
│    AIPort / KnowledgePort / SearchPort / CollectorPort   │
│    ProberPort / NotificationPort / FileSystemPort ...    │
│                                                         │
│  Layer 3: Adapters ───── 技術固有の実装                  │
│    AI:      Anthropic / OpenAI                          │
│    Storage: PostgreSQL / SQLite / Memory                │
│    Search:  FAISS / pgvector                            │
│    Tools:   Sentry / Datadog / Playwright / SSH / ...   │
│    NLP:     MeCab / sentence-transformers               │
│    AST:     tree-sitter                                 │
│                                                         │
│  Layer 4: Entry Points ── 外部との接点 + DI              │
│    FastAPI / Typer CLI / Cron                           │
│                                                         │
├────────────────────────────────────────────────────────┤
│  RPA Layer (separate service)                           │
│    Playwright / SSH / Docker / Remote Debugger          │
├────────────────────────────────────────────────────────┤
│  Target Systems (customer's infrastructure)             │
│    Code / DB / Logs / Staging / Production              │
└────────────────────────────────────────────────────────┘
```

---

## Design Documents

全ての設計判断とその理由は以下のドキュメントに記録されている。

| Document | What | Why |
|----------|------|-----|
| [LAYERS.md](LAYERS.md) | 5層アーキテクチャ | 独立性・テスト容易性・拡張性・再利用性を最大化 |
| [PLATFORM.md](PLATFORM.md) | Product Profile（汎用SaaS対応） | YAML差し替えだけで任意のSaaSに対応 |
| [DISTRIBUTION.md](DISTRIBUTION.md) | SaaS配布・知財保護 | ソースコードと顧客データの両方を守る |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Python化・技術スタック | Agent SDK, FAISS, MeCab等でプロ仕様に |
| [INTERFACES.md](INTERFACES.md) | 28種の証拠収集インターフェース | Collector/Prober/Verifierの3抽象で全手段を統一 |
| [CURIOSITY.md](CURIOSITY.md) | 好奇心探索エンジン | 無知の知。False Known（嘘）の検出が最高優先 |
| [RESPONSE.md](RESPONSE.md) | 8ゲート回答品質パイプライン | 正確性・完全性・誠実性・可読性・行動性・秘密保護 |
| [DATA_SECURITY.md](DATA_SECURITY.md) | DBスキーマ・セキュリティ | テナント分離、RLS、暗号化、監査 |
| [OPERATIONS.md](OPERATIONS.md) | CS運用・1+1体制 | エンジニア1名+CS1名で50件/日を処理 |
| [VISION.md](VISION.md) | 品質基準・開発サイクル | 9軸ベンチマーク、自律改善ループ |
| [ISSUES.md](ISSUES.md) | 課題と解決の軌跡 | 何が問題で、何を試し、何が効いたか |
| [CHANGELOG.md](CHANGELOG.md) | セッションごとの振り返り | 同じ失敗を繰り返さないための記録 |

---

## Current Status (v1)

```
実装: TypeScript / 73ファイル / 14,693行
スコア: 80/100（9軸厳格ベンチマーク、TypeORM 120K行で測定）
```

| Metric | Score | Max |
|--------|-------|-----|
| ファクトチェック通過率 | 15 | 15 |
| ファイル正確性 | 11 | 15 |
| 用語網羅性 | 9.2 | 10 |
| 根拠の具体性 | 15 | 15 |
| 回答の実質性 | 8.9 | 10 |
| 誠実性 | 8-10 | 10 |
| フロー追跡精度 | 5-7.5 | 10 |
| 提案力 | 5 | 5 |
| 応答速度 | 0-2.3 | 10 |

v2ではPython + FastAPI + Agent SDK + PostgreSQL/pgvector に移行予定。

---

## Name

**P**recise **I**ntegrated **E**xpert **C**ollaboration **E**ngine

パズルのピースを1つずつ埋めるように、知識を正確に、漏れなく組み上げていく。
全てのピースが揃った時、完全な理解が完成する。
そして「どのピースが足りないか」を常に知っている。それが無知の知。
