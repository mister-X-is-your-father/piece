import { resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { getKnowledgeDB, closeKnowledgeDB } from "../knowledge/db.js";
import {
  exportToVault,
  importFromVault,
  syncVault,
  type VaultConfig,
} from "../knowledge/obsidian.js";

export interface VaultOptions {
  output?: string;
  specialist?: string;
  flat?: boolean;
  noBacklinks?: boolean;
  noDailyNotes?: boolean;
  verbose?: boolean;
}

export async function runVaultExport(
  targetPath: string,
  options: VaultOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);
  const vaultPath = options.output
    ? resolve(options.output)
    : resolve(rootPath, ".scribe", "vault");

  const db = getKnowledgeDB(scribePath);

  const spinner = ora("Exporting to Obsidian vault...").start();
  try {
    const vaultConfig: VaultConfig = {
      vaultPath,
      scribePath,
      structure: options.flat ? "flat" : "by-specialist",
      backlinks: !options.noBacklinks,
      dailyNotes: !options.noDailyNotes,
    };

    const result = await exportToVault(db, vaultConfig);
    spinner.succeed(
      `Exported ${result.exported} notes, ${result.linked} links → ${vaultPath}`
    );
    console.log(chalk.gray(`\nOpen in Obsidian: ${vaultPath}`));
  } catch (err) {
    spinner.fail(`Export failed: ${err}`);
  } finally {
    closeKnowledgeDB();
  }
}

export async function runVaultImport(
  targetPath: string,
  vaultPath: string,
  options: VaultOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);

  const db = getKnowledgeDB(scribePath);

  const spinner = ora(`Importing from ${vaultPath}...`).start();
  try {
    const result = await importFromVault(
      db,
      resolve(vaultPath),
      options.specialist
    );
    spinner.succeed(
      `Imported ${result.imported} notes, ${result.links} links (${result.skipped} skipped)`
    );
  } catch (err) {
    spinner.fail(`Import failed: ${err}`);
  } finally {
    closeKnowledgeDB();
  }
}

export async function runVaultSync(
  targetPath: string,
  options: VaultOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);
  const vaultPath = options.output
    ? resolve(options.output)
    : resolve(rootPath, ".scribe", "vault");

  const db = getKnowledgeDB(scribePath);

  const spinner = ora("Syncing vault ↔ knowledge DB...").start();
  try {
    const vaultConfig: VaultConfig = {
      vaultPath,
      scribePath,
      structure: options.flat ? "flat" : "by-specialist",
      backlinks: !options.noBacklinks,
      dailyNotes: !options.noDailyNotes,
    };

    const result = await syncVault(db, vaultConfig);
    spinner.succeed(
      `Sync: DB→Vault: ${result.dbToVault}, Vault→DB: ${result.vaultToDb}`
    );
  } catch (err) {
    spinner.fail(`Sync failed: ${err}`);
  } finally {
    closeKnowledgeDB();
  }
}
