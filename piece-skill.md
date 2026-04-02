# PIECE Skill for Claude Code

このファイルを対象プロジェクトの `.claude/skills/piece.md` にコピーすると、
Claude Codeが自動でPIECEの知識を参照するようになる。

## 使い方

```bash
# 対象プロジェクトにスキルを設置
mkdir -p /path/to/project/.claude/skills
cp /home/neo/piece/piece-skill.md /path/to/project/.claude/skills/piece.md
```

---

# piece

コードについて質問されたら、PIECEの知識DBを参照して正確に回答する。

## いつ使うか

- ユーザーがコードの仕組みを質問した時
- 「この機能はどう動いてる？」「この画面の操作方法は？」等
- バグ調査で関連知識を探す時

## 手順

1. まず `.scribe/vault/` のMarkdownを直接Readして既存知識を確認
2. 知識が見つかったらそれを根拠に回答（ファイルパス:行番号を引用）
3. 知識が不足していたら `piece ask . "質問"` を実行して知識を取得・蓄積
4. 回答が間違っていたら `piece feedback . --rating N --text "修正内容"` で学習させる

## 自動蓄積

開発中に以下を定期的に実行すると知識が育つ:

```bash
piece diff-watch .        # コード変更→古い知識を検出
piece investigate .       # 謎を自律調査
piece git-ingest .        # git履歴を知識化
```
