#!/usr/bin/env tsx
/**
 * E2E Benchmark: PIECEの品質を実OSSで厳格に自動測定
 *
 * 評価軸 (100点満点、6軸):
 *   1. ファクトチェック通過率 (20点) — 検証済みstatement / 全statement
 *   2. ファイル正確性 (20点) — 期待ファイルへの言及率
 *   3. 用語網羅性 (15点) — 期待キーワードの登場率
 *   4. 根拠の具体性 (20点) — 引用数×実在性、行番号の実在検証
 *   5. 回答の実質性 (10点) — 長さだけでなく構造・深さの評価
 *   6. 応答速度 (15点) — 初回は30秒以内、キャッシュは1秒以内で満点
 *
 * 減点ルール:
 *   - 存在しないファイルを参照 → 根拠の具体性から-5点/件（嘘ペナルティ）
 *   - ファクトチェック0件 → ファクトチェック通過率は0点（検証されてない＝信頼できない）
 *   - 回答が汎用的（コードベース固有の情報なし） → 回答の実質性0点
 *
 * Usage:
 *   npx tsx tests/e2e-benchmark.ts [target-path] [question-set]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// --- Config ---
const TARGET_PATH = process.argv[2] || "test-targets/typeorm";
const QUESTION_SET = process.argv[3] || "typeorm";
const SCRIBE_PATH = join(TARGET_PATH, ".scribe");

// --- Auto-setup: clone test target if not present ---
const TEST_TARGETS: Record<string, string> = {
  "test-targets/typeorm": "https://github.com/typeorm/typeorm.git",
};

function ensureTestTarget(targetPath: string): void {
  if (existsSync(targetPath)) return;

  const repoUrl = TEST_TARGETS[targetPath];
  if (!repoUrl) return;

  console.log(`Test target not found. Cloning ${repoUrl}...`);
  mkdirSync("test-targets", { recursive: true });
  execSync(`git clone --depth 1 ${repoUrl} ${targetPath}`, {
    stdio: "inherit",
    timeout: 120000,
  });
  console.log(`Cloned. Running PIECE analyze...`);
  execSync(`npm run dev -- analyze ${targetPath}`, {
    stdio: "inherit",
    timeout: 600000,
  });
  console.log(`Analysis complete.`);
}

ensureTestTarget(TARGET_PATH);

// --- Question Sets ---

interface BenchmarkQuestion {
  id: string;
  question: string;
  category: "spec" | "flow" | "config" | "error" | "dependency";
  expectedFiles: string[];
  expectedTerms: string[];
  /** Key facts the answer MUST contain to be considered correct */
  mustContainFacts: string[];
}

const QUESTION_SETS: Record<string, BenchmarkQuestion[]> = {
  typeorm: [
    {
      id: "t1",
      question: "How does TypeORM's QueryBuilder work? What is the internal architecture?",
      category: "spec",
      expectedFiles: ["QueryBuilder.ts", "SelectQueryBuilder.ts", "QueryExpressionMap.ts"],
      expectedTerms: ["querybuilder", "select", "where", "join", "expression"],
      mustContainFacts: ["QueryExpressionMap", "SelectQueryBuilder"],
    },
    {
      id: "t2",
      question: "How does TypeORM handle database migrations? What is the migration execution flow?",
      category: "flow",
      expectedFiles: ["MigrationExecutor.ts", "MigrationInterface.ts"],
      expectedTerms: ["migration", "execute", "up", "down", "run"],
      mustContainFacts: ["MigrationExecutor", "up", "down"],
    },
    {
      id: "t3",
      question: "How does the Entity decorator work? How are entity metadata created?",
      category: "spec",
      expectedFiles: ["Entity.ts", "EntityMetadata.ts", "EntityMetadataBuilder.ts"],
      expectedTerms: ["entity", "decorator", "metadata", "column", "getMetadataArgsStorage"],
      mustContainFacts: ["EntityMetadata"],
    },
    {
      id: "t4",
      question: "How are relationships (OneToMany, ManyToOne) loaded and resolved?",
      category: "flow",
      expectedFiles: ["RelationLoader.ts", "OneToMany.ts", "ManyToOne.ts"],
      expectedTerms: ["relation", "join", "lazy", "eager", "load"],
      mustContainFacts: ["RelationLoader"],
    },
    {
      id: "t5",
      question: "How does TypeORM's connection/DataSource initialization work?",
      category: "flow",
      expectedFiles: ["DataSource.ts", "DriverFactory.ts"],
      expectedTerms: ["datasource", "connection", "initialize", "driver"],
      mustContainFacts: ["DataSource", "initialize"],
    },
    {
      id: "t6",
      question: "How does TypeORM handle transactions?",
      category: "spec",
      expectedFiles: ["EntityManager.ts", "QueryRunner.ts"],
      expectedTerms: ["transaction", "commit", "rollback", "queryrunner", "startTransaction"],
      mustContainFacts: ["QueryRunner", "transaction"],
    },
    {
      id: "t7",
      question: "How does the Repository pattern work in TypeORM?",
      category: "spec",
      expectedFiles: ["Repository.ts", "EntityManager.ts"],
      expectedTerms: ["repository", "find", "save", "remove", "entity", "getRepository"],
      mustContainFacts: ["Repository"],
    },
    {
      id: "t8",
      question: "How does TypeORM handle schema synchronization?",
      category: "flow",
      expectedFiles: ["RdbmsSchemaBuilder.ts", "SchemaBuilder.ts"],
      expectedTerms: ["schema", "synchronize", "create", "table", "column", "alter"],
      mustContainFacts: ["synchronize"],
    },
    {
      id: "t9",
      question: "How does TypeORM's caching mechanism work?",
      category: "spec",
      expectedFiles: ["QueryResultCache.ts", "DbQueryResultCache.ts", "RedisQueryResultCache.ts"],
      expectedTerms: ["cache", "result", "query", "ttl", "invalidat", "redis"],
      mustContainFacts: ["QueryResultCache"],
    },
    {
      id: "t10",
      question: "How are entity subscribers and listeners implemented?",
      category: "spec",
      expectedFiles: ["EntitySubscriberInterface.ts", "EventSubscriber.ts"],
      expectedTerms: ["subscriber", "listener", "event", "before", "after", "insert"],
      mustContainFacts: ["EntitySubscriberInterface"],
    },
    {
      id: "t11",
      question: "What FindOperators are available and how do they translate to SQL?",
      category: "spec",
      expectedFiles: ["FindOperator.ts", "Equal.ts", "Like.ts", "In.ts", "Between.ts"],
      expectedTerms: ["findoperator", "equal", "like", "in", "between", "sql", "toSql"],
      mustContainFacts: ["FindOperator"],
    },
    {
      id: "t12",
      question: "How does TypeORM handle different database drivers (MySQL, PostgreSQL, SQLite)?",
      category: "dependency",
      expectedFiles: ["MysqlDriver.ts", "PostgresDriver.ts", "SqliteDriver.ts", "DriverFactory.ts"],
      expectedTerms: ["driver", "mysql", "postgres", "sqlite", "connect", "createConnection"],
      mustContainFacts: ["DriverFactory"],
    },
    {
      id: "t13",
      question: "How does the CLI tool work? What commands are available?",
      category: "spec",
      expectedFiles: ["CommandUtils.ts", "MigrationGenerateCommand.ts", "MigrationRunCommand.ts"],
      expectedTerms: ["cli", "command", "migration", "generate", "create", "run"],
      mustContainFacts: ["CommandUtils"],
    },
    {
      id: "t14",
      question: "How does TypeORM handle entity inheritance? What strategies are supported?",
      category: "spec",
      expectedFiles: ["TableInheritance.ts", "ChildEntity.ts"],
      expectedTerms: ["inheritance", "single", "table", "child", "discriminator", "STI"],
      mustContainFacts: ["TableInheritance"],
    },
    {
      id: "t15",
      question: "How does the logging system work? What log levels and transports are available?",
      category: "config",
      expectedFiles: ["Logger.ts", "AdvancedConsoleLogger.ts", "FileLogger.ts"],
      expectedTerms: ["logger", "log", "query", "error", "warn", "logQuery"],
      mustContainFacts: ["AdvancedConsoleLogger"],
    },
  ],
};

// --- Scoring Functions ---

interface QuestionResult {
  id: string;
  question: string;
  category: string;
  // Raw data
  answerLength: number;
  hasStructure: boolean; // has headers, code blocks, or bullet points
  hasCodebaseSpecifics: boolean; // mentions actual file paths from the project
  // File accuracy
  fileHitRate: number;
  fileMissCount: number; // referenced files that don't exist (lies)
  // Term coverage
  termHitRate: number;
  // Must-contain facts
  factHitRate: number;
  // Citations
  citationCount: number;
  validCitationCount: number; // citations that point to real files
  hasLineNumbers: boolean;
  validLineNumbers: boolean; // line numbers that actually exist in files
  // Fact check
  factCheckVerified: number;
  factCheckTotal: number;
  // Speed
  responseTimeMs: number;
  fromCache: boolean;
  // Penalties
  lieCount: number; // non-existent files/functions referenced as fact
  // Honesty & depth
  admitsUncertainty: boolean; // says "不明" / "未確認" / "could not verify" when unsure
  hasContradiction: boolean; // contradicts itself within the answer
  flowStepCount: number; // for flow questions: number of ordered processing steps described
  relatedInfoCount: number; // extra useful info beyond what was asked (suggestions, related modules)
}

function scoreAnswer(
  answer: string,
  expected: BenchmarkQuestion,
  targetPath: string,
): Omit<QuestionResult, "id" | "question" | "category" | "responseTimeMs" | "fromCache" | "factCheckVerified" | "factCheckTotal"> {
  const answerLower = answer.toLowerCase();
  const resolvedTarget = resolve(targetPath);

  // --- File accuracy ---
  let fileHits = 0;
  for (const f of expected.expectedFiles) {
    const baseName = f.replace(/\.ts$/, "").toLowerCase();
    if (answerLower.includes(baseName)) fileHits++;
  }
  const fileHitRate = expected.expectedFiles.length > 0 ? fileHits / expected.expectedFiles.length : 0;

  // --- Detect lies: files referenced in answer that don't exist ---
  const allFilePaths = answer.match(/(?:src|lib|packages)\/[\w\-./]+\.(?:ts|js|tsx|jsx)/g) || [];
  const uniquePaths = [...new Set(allFilePaths)];
  let validCitationCount = 0;
  let fileMissCount = 0;
  for (const p of uniquePaths) {
    const fullPath = join(resolvedTarget, p);
    if (existsSync(fullPath)) {
      validCitationCount++;
    } else {
      fileMissCount++;
    }
  }

  // --- Term coverage ---
  let termHits = 0;
  for (const t of expected.expectedTerms) {
    if (answerLower.includes(t.toLowerCase())) termHits++;
  }
  const termHitRate = expected.expectedTerms.length > 0 ? termHits / expected.expectedTerms.length : 0;

  // --- Must-contain facts ---
  let factHits = 0;
  for (const fact of expected.mustContainFacts) {
    if (answerLower.includes(fact.toLowerCase())) factHits++;
  }
  const factHitRate = expected.mustContainFacts.length > 0 ? factHits / expected.mustContainFacts.length : 0;

  // --- Structure check ---
  const hasStructure = /^#+\s/m.test(answer) || /^[-*]\s/m.test(answer) || /```/.test(answer);

  // --- Codebase specifics (not generic knowledge) ---
  const hasCodebaseSpecifics = uniquePaths.length >= 2 || /src\/[\w/]+/.test(answer);

  // --- Line numbers ---
  const hasLineNumbers = /:\d+|line\s+\d+|L\d+/i.test(answer);

  // Validate line numbers against actual files
  let validLineNumbers = false;
  const lineRefs = answer.match(/((?:src|lib)\/[\w\-./]+\.(?:ts|js)):(\d+)/g) || [];
  for (const ref of lineRefs) {
    const parts = ref.match(/(.*):(\d+)/);
    if (parts) {
      const filePath = join(resolvedTarget, parts[1]);
      const lineNum = parseInt(parts[2]);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          if (lineNum > 0 && lineNum <= lines.length) {
            validLineNumbers = true;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  // --- Honesty: admits uncertainty ---
  const admitsUncertainty = /不明|未確認|確認できな|could not verify|unverified|unable to confirm|not found in/i.test(answer);

  // --- Self-contradiction detection ---
  // Simple heuristic: same subject described with conflicting states
  const contradictionPatterns = [
    /は.*である.*は.*ではない/s,
    /is\s+\w+.*is\s+not\s+\w+/is,
    /同期.*非同期|非同期.*同期/,  // sync vs async contradiction
  ];
  const hasContradiction = contradictionPatterns.some((p) => p.test(answer));

  // --- Flow step count (for flow questions) ---
  const stepPatterns = answer.match(/(?:^|\n)\s*(?:\d+[\.\)]\s|step\s*\d|ステップ|→|->)/gi) || [];
  const flowStepCount = stepPatterns.length;

  // --- Related info / suggestions beyond the question ---
  const relatedPatterns = answer.match(/(?:関連|参考|注意|see also|related|tip|note|caveat|also worth|you may also)/gi) || [];
  const relatedInfoCount = relatedPatterns.length;

  return {
    answerLength: answer.length,
    hasStructure,
    hasCodebaseSpecifics,
    fileHitRate,
    fileMissCount,
    termHitRate,
    factHitRate,
    citationCount: uniquePaths.length,
    validCitationCount,
    hasLineNumbers,
    validLineNumbers,
    lieCount: fileMissCount,
    admitsUncertainty,
    hasContradiction,
    flowStepCount,
    relatedInfoCount,
  };
}

// --- Composite Score (strict) ---

function computeStrictScore(results: QuestionResult[]): {
  composite: number;
  breakdown: Record<string, number>;
  issues: string[];
} {
  const n = results.length;
  const issues: string[] = [];

  // ══════════════════════════════════════════════
  // 9 AXES — 100点満点（厳格採点）
  // ══════════════════════════════════════════════

  // 1. ファクトチェック通過率 (15点)
  // 検証ゼロ = 0点。「検証されてない＝信頼できない」
  const totalFcVerified = results.reduce((s, r) => s + r.factCheckVerified, 0);
  const totalFcTotal = results.reduce((s, r) => s + r.factCheckTotal, 0);
  const fcRate = totalFcTotal > 0 ? totalFcVerified / totalFcTotal : 0;
  const fcScore = fcRate * 15;
  if (totalFcTotal === 0) issues.push("CRITICAL: ファクトチェック0件。回答は一切検証されておらず信頼性ゼロ");
  else if (fcRate < 0.5) issues.push(`ファクトチェック通過率${(fcRate * 100).toFixed(0)}%。半数以上が未検証`);

  // 2. ファイル正確性 (15点)
  const avgFileHit = results.reduce((s, r) => s + r.fileHitRate, 0) / n;
  const totalLies = results.reduce((s, r) => s + r.lieCount, 0);
  const liePenalty = Math.min(totalLies * 3, 15); // 嘘1件=-3点、最大-15(全滅)
  const fileScore = Math.max(0, avgFileHit * 15 - liePenalty);
  if (avgFileHit < 0.3) issues.push(`ファイルヒット率${(avgFileHit * 100).toFixed(0)}%。具体的なファイル参照が不足`);
  if (totalLies > 0) issues.push(`嘘検出: 存在しないファイルを${totalLies}件参照 (-${liePenalty}点)`);

  // 3. 用語網羅性 (10点)
  const avgTermHit = results.reduce((s, r) => s + r.termHitRate, 0) / n;
  const termScore = avgTermHit * 10;
  if (avgTermHit < 0.5) issues.push(`用語ヒット率${(avgTermHit * 100).toFixed(0)}%。トピックのカバレッジ不足`);

  // 4. 根拠の具体性 (15点)
  const avgValidCitations = results.reduce((s, r) => s + r.validCitationCount, 0) / n;
  const validLineRate = results.filter((r) => r.validLineNumbers).length / n;
  const citationScore =
    Math.min(avgValidCitations / 4, 1) * 9 + // 実在ファイル4件以上で満点(9点)
    validLineRate * 6; // 実在行番号率(6点)
  if (avgValidCitations < 1) issues.push("実在する引用が平均1件未満。根拠なしの回答");
  if (validLineRate < 0.1) issues.push("実在する行番号の引用がほぼゼロ");

  // 5. 回答の実質性 + 必須ファクト (10点)
  const factCoverage = results.reduce((s, r) => s + r.factHitRate, 0) / n;
  const substantiveCount = results.filter(
    (r) => r.answerLength > 300 && r.hasStructure && r.hasCodebaseSpecifics
  ).length;
  const substScore = (substantiveCount / n) * 4 + factCoverage * 6;
  if (factCoverage < 0.5) issues.push(`必須ファクト言及率${(factCoverage * 100).toFixed(0)}%。核心情報の欠落`);

  // 6. 誠実性 (10点)
  // 矛盾がある = -5点、不確実さを認めない = -5点
  const contradictionCount = results.filter((r) => r.hasContradiction).length;
  const admitsCount = results.filter((r) => r.admitsUncertainty).length;
  // 矛盾はゼロが理想。1件ごとに-2点
  const contradictionPenalty = Math.min(contradictionCount * 2, 5);
  // 15問中1問も「わからない」と言えないのは怪しい（知ったかぶりの可能性）
  // ただし全問正確なら問題ない。ファイルヒット率が低いのに不確実性を認めないのは減点
  const honestyBonus = admitsCount > 0 ? 5 : (avgFileHit > 0.7 ? 5 : 0);
  const honestyScore = Math.max(0, honestyBonus + 5 - contradictionPenalty);
  if (contradictionCount > 0) issues.push(`矛盾検出: ${contradictionCount}件の回答に自己矛盾あり`);
  if (admitsCount === 0 && avgFileHit < 0.5) issues.push("不確実性を一切認めない。精度が低いのに「知ったかぶり」の疑い");

  // 7. フロー追跡精度 (10点)
  // flow カテゴリの質問で、処理ステップが3以上記述されているか
  const flowQuestions = results.filter((r) => r.category === "flow");
  let flowScore = 10; // default full if no flow questions
  if (flowQuestions.length > 0) {
    const goodFlows = flowQuestions.filter((r) => r.flowStepCount >= 3).length;
    flowScore = (goodFlows / flowQuestions.length) * 10;
    if (goodFlows < flowQuestions.length) {
      issues.push(`フロー追跡: ${flowQuestions.length}問中${flowQuestions.length - goodFlows}問で処理ステップが3未満。フロー説明が不十分`);
    }
  }

  // 8. 提案力 (5点)
  // 質問への直接回答だけでなく、関連情報・注意点・提案を含んでいるか
  const avgRelated = results.reduce((s, r) => s + r.relatedInfoCount, 0) / n;
  const proposalScore = Math.min(avgRelated / 2, 1) * 5; // 平均2件以上で満点
  if (avgRelated < 0.5) issues.push("提案・関連情報の付加がほぼない。質問にしか答えていない");

  // 9. 応答速度 (10点)
  let speedScore = 0;
  for (const r of results) {
    if (r.fromCache) {
      speedScore += r.responseTimeMs < 1000 ? 10 : r.responseTimeMs < 3000 ? 5 : 0;
    } else {
      speedScore += r.responseTimeMs < 20000 ? 10 : r.responseTimeMs < 45000 ? 5 : 0;
    }
  }
  speedScore = speedScore / n;

  const composite = Math.round(
    fcScore + fileScore + termScore + citationScore +
    substScore + honestyScore + flowScore + proposalScore + speedScore
  );

  return {
    composite: Math.max(0, Math.min(100, composite)),
    breakdown: {
      factCheck_15: Math.round(fcScore * 10) / 10,
      fileAccuracy_15: Math.round(fileScore * 10) / 10,
      termCoverage_10: Math.round(termScore * 10) / 10,
      evidenceQuality_15: Math.round(citationScore * 10) / 10,
      substance_10: Math.round(substScore * 10) / 10,
      honesty_10: Math.round(honestyScore * 10) / 10,
      flowTracking_10: Math.round(flowScore * 10) / 10,
      proposals_5: Math.round(proposalScore * 10) / 10,
      speed_10: Math.round(speedScore * 10) / 10,
    },
    issues,
  };
}

// --- Runner ---

async function runBenchmark(): Promise<void> {
  const targetPath = resolve(TARGET_PATH);
  const questions = QUESTION_SETS[QUESTION_SET];

  if (!questions) {
    console.error(`Unknown question set: ${QUESTION_SET}. Available: ${Object.keys(QUESTION_SETS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n=== PIECE E2E Benchmark (STRICT) ===`);
  console.log(`Target: ${targetPath}`);
  console.log(`Questions: ${questions.length} (${QUESTION_SET})`);
  console.log(`---\n`);

  if (!existsSync(join(targetPath, ".scribe"))) {
    console.error("ERROR: Target not analyzed. Run: npm run dev -- analyze " + TARGET_PATH);
    process.exit(1);
  }

  const results: QuestionResult[] = [];

  for (const q of questions) {
    process.stdout.write(`[${q.id}] ${q.question.slice(0, 55)}... `);
    const start = Date.now();

    let answer = "";
    let fromCache = false;

    try {
      const output = execSync(
        `npm run dev -- ask "${targetPath}" "${q.question.replace(/"/g, '\\"')}"`,
        { timeout: 180000, encoding: "utf-8", cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"] }
      );
      answer = output;
      fromCache = /cache|キャッシュ|cached|即答/i.test(answer);
    } catch (e: any) {
      answer = e.stdout || "";
    }

    const elapsed = Date.now() - start;

    // Extract fact-check stats from the output
    const fcMatch = answer.match(/(\d+)\s*verified.*?(\d+)\s*partial.*?(\d+)\s*unverified/i);
    let fcVerified = 0;
    let fcTotal = 0;
    if (fcMatch) {
      fcVerified = parseInt(fcMatch[1]);
      const fcPartial = parseInt(fcMatch[2]);
      const fcUnverified = parseInt(fcMatch[3]);
      fcTotal = fcVerified + fcPartial + fcUnverified;
    }

    const scores = scoreAnswer(answer, q, TARGET_PATH);

    const result: QuestionResult = {
      id: q.id, question: q.question, category: q.category,
      ...scores,
      factCheckVerified: fcVerified,
      factCheckTotal: fcTotal,
      responseTimeMs: elapsed,
      fromCache,
    };

    results.push(result);

    const status = scores.factHitRate >= 0.5 && scores.fileHitRate >= 0.3 ? "OK" : "WEAK";
    console.log(`${status} file:${(scores.fileHitRate * 100).toFixed(0)}% term:${(scores.termHitRate * 100).toFixed(0)}% fact:${(scores.factHitRate * 100).toFixed(0)}% cite:${scores.validCitationCount}/${scores.citationCount} lies:${scores.lieCount} fc:${fcVerified}/${fcTotal} ${elapsed}ms`);
  }

  // --- Strict Composite Score ---
  const { composite, breakdown, issues } = computeStrictScore(results);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  STRICT BENCHMARK RESULTS (9-axis)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  1. ファクトチェック通過率:  ${breakdown.factCheck_15}/15`);
  console.log(`  2. ファイル正確性:          ${breakdown.fileAccuracy_15}/15`);
  console.log(`  3. 用語網羅性:              ${breakdown.termCoverage_10}/10`);
  console.log(`  4. 根拠の具体性:            ${breakdown.evidenceQuality_15}/15`);
  console.log(`  5. 回答の実質性:            ${breakdown.substance_10}/10`);
  console.log(`  6. 誠実性:                  ${breakdown.honesty_10}/10`);
  console.log(`  7. フロー追跡精度:          ${breakdown.flowTracking_10}/10`);
  console.log(`  8. 提案力:                  ${breakdown.proposals_5}/5`);
  console.log(`  9. 応答速度:                ${breakdown.speed_10}/10`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  COMPOSITE SCORE:            ${composite}/100`);
  console.log(`${"═".repeat(60)}`);

  if (issues.length > 0) {
    console.log(`\n=== 課題 (${issues.length}件) ===`);
    for (const issue of issues) {
      console.log(`  ❌ ${issue}`);
    }
  }

  // --- Per-question detail ---
  console.log(`\n=== Per-Question Detail ===`);
  console.log(`${"ID".padEnd(5)} ${"Cat".padEnd(6)} ${"File%".padEnd(6)} ${"Term%".padEnd(6)} ${"Fact%".padEnd(6)} ${"Cite".padEnd(6)} ${"Lies".padEnd(5)} ${"FC".padEnd(6)} ${"ms".padEnd(7)}`);
  for (const r of results) {
    console.log(
      `${r.id.padEnd(5)} ${r.category.padEnd(6)} ${(r.fileHitRate * 100).toFixed(0).padStart(4)}% ` +
      `${(r.termHitRate * 100).toFixed(0).padStart(4)}% ${(r.factHitRate * 100).toFixed(0).padStart(4)}% ` +
      `${String(r.validCitationCount).padStart(2)}/${String(r.citationCount).padStart(2)} ` +
      `${String(r.lieCount).padStart(3)}  ${r.factCheckVerified}/${r.factCheckTotal}  ${r.responseTimeMs}`
    );
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    target: TARGET_PATH,
    questionSet: QUESTION_SET,
    totalQuestions: results.length,
    compositeScore: composite,
    breakdown,
    issues,
    perQuestion: results.map((r) => ({
      id: r.id, cat: r.category,
      fileHit: r.fileHitRate, termHit: r.termHitRate, factHit: r.factHitRate,
      citations: r.citationCount, validCitations: r.validCitationCount, lies: r.lieCount,
      fcVerified: r.factCheckVerified, fcTotal: r.factCheckTotal,
      ms: r.responseTimeMs, cached: r.fromCache,
    })),
  };

  const reportPath = join(SCRIBE_PATH, "benchmark-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nSaved: ${reportPath}`);
}

runBenchmark().catch(console.error);
