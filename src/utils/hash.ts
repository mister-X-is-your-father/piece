import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return hashContent(content);
}
