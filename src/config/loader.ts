import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ScribeConfig, ScribeConfigSchema } from "./schema.js";
import { CONFIG_FILENAME } from "./defaults.js";

export async function loadConfig(
  targetPath: string,
  configPath?: string
): Promise<ScribeConfig> {
  const filePath = configPath ?? join(targetPath, CONFIG_FILENAME);

  try {
    const raw = await readFile(filePath, "utf-8");
    let parsed = JSON.parse(raw);

    // Support ${ENV_VAR} interpolation
    const jsonStr = JSON.stringify(parsed).replace(
      /\$\{(\w+)\}/g,
      (_, key) => process.env[key] ?? ""
    );
    parsed = JSON.parse(jsonStr);

    return ScribeConfigSchema.parse(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config file, use defaults
      return ScribeConfigSchema.parse({});
    }
    throw new Error(`Failed to load config from ${filePath}: ${err}`);
  }
}
