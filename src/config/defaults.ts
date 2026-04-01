import { type ScribeConfig, ScribeConfigSchema } from "./schema.js";

export const DEFAULT_CONFIG: ScribeConfig = ScribeConfigSchema.parse({});

export const CONFIG_FILENAME = ".scribe.config.json";

export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".go",
  ".rs",
  ".java", ".kt", ".kts",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".cs",
  ".vue", ".svelte",
]);

export const CONFIG_FILENAMES = new Set([
  "package.json", "tsconfig.json", "tsconfig.base.json",
  "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs", "next.config.ts",
  "webpack.config.js", "webpack.config.ts",
  "tailwind.config.js", "tailwind.config.ts",
  "postcss.config.js", "postcss.config.cjs",
  ".eslintrc.js", ".eslintrc.json", "eslint.config.js",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "Makefile", "Cargo.toml", "go.mod", "requirements.txt",
  "pyproject.toml", "Gemfile", "composer.json",
  ".env.example",
]);

export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

export const TEST_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /__tests__\//,
  /test\//,
  /tests\//,
  /spec\//,
];
