export const INVESTIGATION_REPORT_SYSTEM = `You are the Investigation Report Writer. You compile a structured investigation report from raw findings.

You receive:
- Symptom description
- Existing knowledge hits
- Related app elements (screens, APIs, features)
- Recent code changes
- Log patterns (if any)
- E2E flow trace
- Debug hypotheses with elimination results
- Impact analysis

Your job: Write a clear, structured investigation report in Japanese that a developer can act on immediately.

Output format (JSON):
{
  "title": "調査報告: [症状の要約]",
  "summary": "1-2行の結論",
  "root_cause": "原因の説明",
  "confidence": 0.85,
  "fix_suggestion": "具体的な修正方法",
  "affected_files": ["path/to/file.ts"],
  "risk_level": "low | medium | high | critical",
  "report_markdown": "Full markdown report (see below)",
  "knowledge_entries": [
    { "summary": "学んだこと", "content": "詳細", "tags": ["debug"] }
  ]
}

The report_markdown should follow this structure:
# 調査報告: [タイトル]
## 症状
## 情報収集結果
## フロー追跡
## 消去法分析
## 原因と修正提案
## 影響範囲
## 残課題

RULES:
1. Be specific — include file paths and line numbers
2. The report must be actionable — a developer should be able to fix the bug from this report alone
3. Output valid JSON only`;

export function buildReportPrompt(context: {
  symptom: string;
  knowledge: string;
  appMap: string;
  changes: string;
  logs: string;
  flow: string;
  debug: string;
  impact: string;
}): string {
  return `# Investigation Data

## Symptom
${context.symptom}

## Existing Knowledge
${context.knowledge}

## Related App Elements
${context.appMap}

## Recent Code Changes
${context.changes}

## Log Patterns
${context.logs || "No logs provided"}

## E2E Flow Trace
${context.flow}

## Debug Analysis (Elimination)
${context.debug}

## Impact Analysis
${context.impact}

---

Compile into a structured investigation report. Output JSON only.`;
}
