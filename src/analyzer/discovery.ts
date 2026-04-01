import { join } from "node:path";
import type { FileEntry, ScribeConfig } from "../config/schema.js";
import { discoverFiles, categorizeFile, getFileStat } from "../utils/fs.js";
import { hashFile } from "../utils/hash.js";
import { logger } from "../utils/logger.js";

export async function discoverProjectFiles(
  rootPath: string,
  config: ScribeConfig
): Promise<FileEntry[]> {
  logger.info(`Discovering files in ${rootPath}...`);

  const relativePaths = await discoverFiles(
    rootPath,
    config.target.include,
    config.target.exclude
  );

  logger.info(`Found ${relativePaths.length} files matching patterns`);

  const entries: FileEntry[] = [];

  for (const relPath of relativePaths) {
    const absPath = join(rootPath, relPath);
    try {
      const { sizeBytes, lastModified } = await getFileStat(absPath);

      if (sizeBytes > config.target.maxFileSize) {
        logger.debug(`Skipping oversized file: ${relPath} (${sizeBytes} bytes)`);
        continue;
      }

      const category = categorizeFile(relPath);
      const hash = await hashFile(absPath);

      entries.push({
        path: absPath,
        relativePath: relPath,
        category,
        sizeBytes,
        lastModified,
        hash,
      });
    } catch (err) {
      logger.warn(`Failed to process ${relPath}: ${err}`);
    }
  }

  const byCategory = entries.reduce(
    (acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  logger.info(
    `Discovered ${entries.length} files: ${Object.entries(byCategory)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );

  return entries;
}
