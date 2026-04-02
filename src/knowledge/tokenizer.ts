/**
 * Brain-inspired tokenizer.
 *
 * Japanese: character n-grams (bigram + trigram)
 * English: word-level tokens
 * Mixed: detect script runs, apply appropriate strategy
 */

export interface TokenResult {
  token: string;
  count: number;
}

// Shared stop words (Japanese + English)
export const STOP_WORDS = new Set([
  // Japanese particles/connectors
  "の", "は", "が", "を", "に", "で", "と", "も", "か", "から", "まで", "より",
  "こと", "もの", "ため", "よう", "ところ", "ここ", "それ", "これ", "あれ",
  "する", "した", "している", "される", "できる", "ある", "いる", "なる",
  "ている", "てる", "です", "ます", "だ", "である",
  "どう", "どの", "どこ", "なに", "いつ", "なぜ",
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "how", "what", "which", "who", "where", "when", "why",
  "this", "that", "these", "those", "it", "its",
  "and", "or", "but", "not", "no", "if", "then",
]);

export function isJapanese(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth
    (code >= 0x3000 && code <= 0x303f)    // CJK Symbols
  );
}

interface ScriptRun {
  text: string;
  isJapanese: boolean;
}

function splitByScript(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let current = "";
  let currentIsJp = false;

  for (const char of text) {
    const jp = isJapanese(char);
    if (current.length === 0) {
      currentIsJp = jp;
      current = char;
    } else if (jp === currentIsJp) {
      current += char;
    } else {
      if (current.trim()) runs.push({ text: current.trim(), isJapanese: currentIsJp });
      current = char;
      currentIsJp = jp;
    }
  }
  if (current.trim()) runs.push({ text: current.trim(), isJapanese: currentIsJp });

  return runs;
}

/**
 * Tokenize text into searchable tokens.
 * Japanese → character bigrams + trigrams
 * English → word-level, lowercased, stop-words removed
 */
export function tokenize(text: string): TokenResult[] {
  const freq = new Map<string, number>();

  const runs = splitByScript(text);

  for (const run of runs) {
    if (run.isJapanese) {
      // Character n-grams: bigrams AND trigrams
      const chars = [...run.text].filter(
        (c) => !c.match(/[\s。、！？「」（）・\u3000]/)
      );
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i <= chars.length - n; i++) {
          const gram = chars.slice(i, i + n).join("");
          freq.set(gram, (freq.get(gram) || 0) + 1);
        }
      }
      // Also include individual CJK chars that are meaningful (2+ occurrences skipped for single chars)
    } else {
      // English: word-level tokens
      const words = run.text
        .toLowerCase()
        .split(/[\s\-_./(){}[\]:;,'"!?]+/)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
      for (const word of words) {
        freq.set(word, (freq.get(word) || 0) + 1);
      }
    }
  }

  return [...freq.entries()].map(([token, count]) => ({ token, count }));
}

/**
 * Tokenize a query (same as tokenize but also returns original terms for concept expansion).
 */
export function tokenizeQuery(text: string): {
  tokens: TokenResult[];
  originalTerms: string[];
} {
  const tokens = tokenize(text);

  // Also extract original meaningful terms (pre-ngram)
  const originalTerms: string[] = [];
  const runs = splitByScript(text);
  for (const run of runs) {
    if (run.isJapanese) {
      // Keep full Japanese words/phrases as-is for concept lookup
      const cleaned = run.text.replace(/[\s。、！？\u3000]/g, "");
      if (cleaned.length >= 2) originalTerms.push(cleaned);
    } else {
      const words = run.text
        .toLowerCase()
        .split(/[\s\-_./]+/)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
      originalTerms.push(...words);
    }
  }

  return { tokens, originalTerms };
}

// --- Query Preprocessing ---

export interface PreprocessedQuery {
  /** Normalized query (NFKC, lowered, whitespace-collapsed) */
  normalized: string;
  /** Quoted phrases extracted from query */
  phrases: string[];
  /** Negated terms (after - or NOT) */
  negations: string[];
  /** Must-include terms (after +) */
  mustInclude: string[];
  /** Fuzzy-corrected form (edit-distance=1 matches against vocabulary) */
  corrected: string;
}

/**
 * Preprocess a raw query into a structured form.
 *
 * - NFKC normalization (unifies fullwidth/halfwidth, 全角半角統一)
 * - Phrase extraction: "exact" / 「完全一致」
 * - Negation: -term / NOT term
 * - Must-include: +term
 * - Fuzzy correction against known vocabulary
 */
export function preprocessQuery(
  raw: string,
  vocabulary?: Set<string>
): PreprocessedQuery {
  // NFKC normalize (fullwidth → halfwidth, etc.)
  let text = raw.normalize("NFKC");

  // Extract quoted phrases
  const phrases: string[] = [];
  text = text.replace(/「([^」]+)」/g, (_, p) => { phrases.push(p); return " "; });
  text = text.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p); return " "; });

  // Extract negations (-term / NOT term)
  const negations: string[] = [];
  text = text.replace(/\bNOT\s+(\S+)/gi, (_, t) => { negations.push(t.toLowerCase()); return " "; });
  text = text.replace(/(?:^|\s)-(\S+)/g, (_, t) => { negations.push(t.toLowerCase()); return " "; });

  // Extract must-include (+term)
  const mustInclude: string[] = [];
  text = text.replace(/(?:^|\s)\+(\S+)/g, (_, t) => { mustInclude.push(t.toLowerCase()); return " "; });

  // Normalize: lowercase, collapse whitespace
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  // Fuzzy correction: for each English word, check edit-distance=1 against vocabulary
  let corrected = normalized;
  if (vocabulary && vocabulary.size > 0) {
    const words = normalized.split(/\s+/);
    const correctedWords = words.map((word) => {
      if (word.length < 3 || isJapanese(word[0])) return word;
      if (vocabulary.has(word)) return word;
      // Generate edit-distance=1 candidates
      const candidate = findClosestWord(word, vocabulary);
      return candidate ?? word;
    });
    corrected = correctedWords.join(" ");
  }

  return { normalized, phrases, negations, mustInclude, corrected };
}

/**
 * Find the closest word in vocabulary by Damerau-Levenshtein distance = 1.
 */
function findClosestWord(word: string, vocabulary: Set<string>): string | null {
  const candidates = generateEditDistance1(word);
  for (const c of candidates) {
    if (vocabulary.has(c)) return c;
  }
  return null;
}

/**
 * Generate all strings at edit distance 1 (deletion, insertion, substitution, transposition).
 */
function generateEditDistance1(word: string): string[] {
  const results: string[] = [];
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789_";

  for (let i = 0; i < word.length; i++) {
    // Deletion
    results.push(word.slice(0, i) + word.slice(i + 1));
    // Substitution
    for (const c of chars) {
      if (c !== word[i]) results.push(word.slice(0, i) + c + word.slice(i + 1));
    }
    // Transposition
    if (i < word.length - 1) {
      results.push(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    }
  }
  // Insertion
  for (let i = 0; i <= word.length; i++) {
    for (const c of chars) {
      results.push(word.slice(0, i) + c + word.slice(i));
    }
  }

  return results;
}
