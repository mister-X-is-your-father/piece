import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import chalk from "chalk";
import fg from "fast-glob";
import type { ScribeMetadata, DomainJson } from "../config/schema.js";

export interface ListOptions {
  verbose?: boolean;
}

/**
 * List specialists for an analyzed project.
 */
export async function runList(
  targetPath?: string,
  options: ListOptions = {}
): Promise<void> {
  if (targetPath) {
    await listProjectSpecialists(resolve(targetPath), options);
  } else {
    // Search for .scribe directories in current dir
    const scribeDirs = await fg("**/.scribe/scribe.json", {
      cwd: process.cwd(),
      ignore: ["node_modules"],
      deep: 3,
    });

    if (scribeDirs.length === 0) {
      console.log(
        chalk.yellow("No analyzed projects found in current directory.")
      );
      return;
    }

    for (const dir of scribeDirs) {
      const projectPath = resolve(process.cwd(), dir, "../..");
      console.log(chalk.cyan(`\n${projectPath}`));
      await listProjectSpecialists(projectPath, options);
    }
  }
}

async function listProjectSpecialists(
  rootPath: string,
  options: ListOptions
): Promise<void> {
  const scribePath = join(rootPath, ".scribe");

  try {
    const raw = await readFile(join(scribePath, "scribe.json"), "utf-8");
    const metadata: ScribeMetadata = JSON.parse(raw);

    console.log(chalk.gray(`  Analyzed: ${metadata.analyzedAt}`));
    console.log(chalk.gray(`  Files: ${Object.keys(metadata.fileHashes).length}`));
    console.log(`  Specialists: ${metadata.specialists.length}`);

    for (const name of metadata.specialists) {
      try {
        const domainRaw = await readFile(
          join(scribePath, "specialists", name, "domain.json"),
          "utf-8"
        );
        const domain: DomainJson = JSON.parse(domainRaw);

        console.log(
          `    ${chalk.cyan(name)}: ${domain.description} (${domain.files.length} files)`
        );

        if (options.verbose) {
          console.log(
            `      Keywords: ${domain.keywords.slice(0, 10).join(", ")}`
          );
          console.log(`      Files: ${domain.files.join(", ")}`);
          if (domain.dependencies.length > 0) {
            console.log(`      Depends on: ${domain.dependencies.join(", ")}`);
          }
        }
      } catch {
        console.log(`    ${chalk.yellow(name)}: (domain.json not found)`);
      }
    }
  } catch {
    console.log(chalk.red(`  No analysis found at ${scribePath}`));
  }
}
