import { resolve } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { closeKnowledgeDB } from "../knowledge/db.js";
import type { MysteryStatus } from "../knowledge/schemas.js";

export interface MysteriesOptions {
  all?: boolean;
  specialist?: string;
  add?: string;
  resolve?: string;
  verbose?: boolean;
}

export async function runMysteries(
  targetPath: string,
  options: MysteriesOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);

  const store = new MysteryStore(scribePath);

  try {
    // Add a mystery manually
    if (options.add) {
      const mystery = store.insertMystery({
        title: options.add,
        description: options.add,
        specialist: options.specialist || null,
        source: "manual",
      });
      console.log(chalk.green(`Mystery created: ${mystery.id}`));
      console.log(`  ${mystery.title}`);
      return;
    }

    // Resolve a mystery
    if (options.resolve) {
      store.updateMystery(options.resolve, { status: "wont_fix" });
      console.log(chalk.green(`Mystery ${options.resolve} marked as resolved`));
      return;
    }

    // List mysteries
    const filter: { status?: MysteryStatus; specialist?: string } = {};
    if (!options.all) {
      filter.status = "open";
    }
    if (options.specialist) {
      filter.specialist = options.specialist;
    }

    const mysteries = store.listMysteries(filter);
    const stats = store.getStats();

    console.log(chalk.cyan("━━━ Mysteries ━━━\n"));
    console.log(
      chalk.gray(
        `Total: ${stats.total} | Open: ${stats.open} | Investigating: ${stats.investigating} | Resolved: ${stats.resolved}`
      )
    );
    console.log();

    if (mysteries.length === 0) {
      console.log(chalk.gray("  No mysteries found."));
      return;
    }

    for (const m of mysteries) {
      const statusIcon =
        m.status === "open"
          ? chalk.red("●")
          : m.status === "investigating"
            ? chalk.yellow("◐")
            : m.status === "resolved"
              ? chalk.green("✓")
              : chalk.gray("✗");

      const priority = m.priority >= 7 ? chalk.red(`P${m.priority}`) : chalk.yellow(`P${m.priority}`);

      console.log(
        `  ${statusIcon} ${priority} ${m.title}`
      );
      console.log(chalk.gray(`     ID: ${m.id} | Source: ${m.source} | ${m.created_at}`));

      if (options.verbose) {
        console.log(chalk.gray(`     ${m.description}`));
        if (m.specialist) {
          console.log(chalk.gray(`     Specialist: ${m.specialist}`));
        }
        if (m.context) {
          console.log(chalk.gray(`     Context: ${m.context}`));
        }
      }
      console.log();
    }
  } finally {
    closeKnowledgeDB();
  }
}
