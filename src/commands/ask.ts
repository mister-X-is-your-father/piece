import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { orchestrateQuestion } from "../agents/orchestrator.js";
import { factCheckAnswer, formatFactCheckReport } from "../agents/fact-checker.js";
import type { ScribeMetadata } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface AskOptions {
  config?: string;
  docs?: string;
  maxDocs?: number;
  skipFactCheck?: boolean;
  verbose?: boolean;
}

export async function runAsk(
  targetPath: string,
  question: string,
  options: AskOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath, options.config);

  const scribePath = options.docs
    ? resolve(options.docs)
    : resolve(rootPath, config.output.directory);

  // Verify .scribe exists
  let metadata: ScribeMetadata;
  try {
    const raw = await readFile(resolve(scribePath, "scribe.json"), "utf-8");
    metadata = JSON.parse(raw);
  } catch {
    console.error(
      chalk.red(
        `No analysis found at ${scribePath}. Run 'codebase-scribe analyze ${targetPath}' first.`
      )
    );
    process.exit(1);
  }

  console.log(chalk.gray(`Project: ${metadata.projectPath}`));
  console.log(chalk.gray(`Analyzed: ${metadata.analyzedAt}`));
  console.log(chalk.gray(`Specialists: ${metadata.specialists.join(", ")}`));
  console.log();

  // Step 1: Orchestrate — route question to specialists and get answer
  const spinner = ora("Consulting specialists...").start();

  let result;
  try {
    result = await orchestrateQuestion(question, scribePath, config);
    spinner.succeed(
      `Consulted: ${result.specialistsConsulted.join(", ") || "none"}`
    );
  } catch (err) {
    spinner.fail(`Query failed: ${err}`);
    throw err;
  }

  // Step 2: Fact check
  let factCheckReport;
  if (!options.skipFactCheck && config.factCheck.enabled) {
    const spinner2 = ora("Verifying answer against source code...").start();

    try {
      factCheckReport = await factCheckAnswer(
        result.answer,
        rootPath,
        scribePath,
        config
      );
      const { summary } = factCheckReport;
      spinner2.succeed(
        `Fact check: ${summary.verified} verified, ${summary.partial} partial, ${summary.unverified} unverified`
      );
    } catch (err) {
      spinner2.warn(`Fact check encountered issues: ${err}`);
    }
  }

  // Step 3: Display answer
  console.log(chalk.cyan("\n━━━ Answer ━━━\n"));
  console.log(result.answer);

  // Step 4: Display fact check results
  if (factCheckReport && factCheckReport.statements.length > 0) {
    console.log(chalk.cyan("\n━━━ Fact Check ━━━\n"));
    console.log(formatFactCheckReport(factCheckReport));
  }

  // Step 5: Display consulted specialists
  if (result.specialistsConsulted.length > 0) {
    console.log(
      chalk.gray(
        `\nSpecialists consulted: ${result.specialistsConsulted.join(", ")}`
      )
    );
  }
}
