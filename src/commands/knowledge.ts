import { resolve } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { FlowStore } from "../knowledge/flow-store.js";
import { InvestigationStore } from "../knowledge/investigation-store.js";
import { closeKnowledgeDB } from "../knowledge/db.js";

export interface KnowledgeOptions {
  search?: string;
  graph?: boolean;
  specialist?: string;
  export?: boolean;
  verbose?: boolean;
}

export async function runKnowledge(
  targetPath: string,
  options: KnowledgeOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);

  const knowledgeStore = new KnowledgeStore(scribePath);
  const mysteryStore = new MysteryStore(scribePath);
  const flowStore = new FlowStore(scribePath);
  const investigationStore = new InvestigationStore(scribePath);

  try {
    if (options.search) {
      searchKnowledge(knowledgeStore, options.search, options.verbose);
      return;
    }

    if (options.graph) {
      showGraph(knowledgeStore);
      return;
    }

    // Default: show stats
    showStats(knowledgeStore, mysteryStore, flowStore, investigationStore);
  } finally {
    closeKnowledgeDB();
  }
}

function showStats(
  knowledgeStore: KnowledgeStore,
  mysteryStore: MysteryStore,
  flowStore: FlowStore,
  investigationStore: InvestigationStore
): void {
  const nodeCount = knowledgeStore.getNodeCount();
  const tags = knowledgeStore.getAllTags();
  const mysteryStats = mysteryStore.getStats();
  const flowCount = flowStore.getFlowCount();
  const invStats = investigationStore.getStats();
  const cacheStats = knowledgeStore.getQueryCacheStats();

  console.log(chalk.cyan("━━━ Knowledge Brain Stats ━━━\n"));

  console.log(chalk.cyan("Knowledge Nodes"));
  console.log(`  Total: ${nodeCount}`);
  if (tags.length > 0) {
    console.log(`  Top tags: ${tags.slice(0, 10).map((t) => `${t.tag}(${t.count})`).join(", ")}`);
  }

  console.log(chalk.cyan("\nQuery Cache"));
  console.log(`  Cached queries: ${cacheStats.total}`);
  console.log(`  Cache hits: ${cacheStats.totalHits}`);

  console.log(chalk.cyan("\nMysteries"));
  console.log(
    `  Open: ${mysteryStats.open} | Investigating: ${mysteryStats.investigating} | Resolved: ${mysteryStats.resolved} | Total: ${mysteryStats.total}`
  );

  console.log(chalk.cyan("\nE2E Flows"));
  console.log(`  Total: ${flowCount}`);

  console.log(chalk.cyan("\nInvestigations"));
  console.log(
    `  Total: ${invStats.total} | Completed: ${invStats.completed} | Nodes created: ${invStats.totalNodesCreated} | Mysteries resolved: ${invStats.totalMysteriesResolved}`
  );
}

function searchKnowledge(
  store: KnowledgeStore,
  query: string,
  verbose?: boolean
): void {
  const results = store.searchForAnswer(query, 20);

  console.log(chalk.cyan(`━━━ Knowledge Search: "${query}" ━━━\n`));

  if (results.length === 0) {
    console.log(chalk.gray("  No results found."));
    return;
  }

  console.log(chalk.gray(`  ${results.length} results\n`));

  for (const r of results) {
    const confidence =
      r.node.confidence >= 0.8
        ? chalk.green(`${(r.node.confidence * 100).toFixed(0)}%`)
        : r.node.confidence >= 0.5
          ? chalk.yellow(`${(r.node.confidence * 100).toFixed(0)}%`)
          : chalk.red(`${(r.node.confidence * 100).toFixed(0)}%`);

    console.log(`  ${confidence} ${r.node.summary}`);
    console.log(
      chalk.gray(
        `     Type: ${r.node.node_type} | Accessed: ${r.node.access_count}x | Relevance: ${r.relevance.toFixed(1)}`
      )
    );

    if (verbose) {
      console.log(chalk.gray(`     ${r.node.content.slice(0, 300)}`));
      for (const cit of r.citations) {
        console.log(chalk.gray(`     📎 ${cit.file_path}:L${cit.start_line}`));
      }
    }
    console.log();
  }
}

function showGraph(store: KnowledgeStore): void {
  console.log(chalk.cyan("━━━ Knowledge Graph ━━━\n"));

  // Get all nodes with their links
  const results = store.searchNodes("*", 50);

  if (results.length === 0) {
    console.log(chalk.gray("  No knowledge nodes yet."));
    return;
  }

  for (const r of results) {
    const links = store.getNodeLinks(r.node.id);
    const tags = store.getNodeTags(r.node.id);

    console.log(`  ${chalk.cyan("●")} ${r.node.summary}`);
    if (tags.length > 0) {
      console.log(chalk.gray(`     Tags: ${tags.join(", ")}`));
    }

    for (const link of links) {
      const isSource = link.source_id === r.node.id;
      const otherId = isSource ? link.target_id : link.source_id;
      const otherNode = store.getNode(otherId);
      const arrow = isSource ? "→" : "←";
      const linkLabel = link.link_type;

      if (otherNode) {
        console.log(
          chalk.gray(`     ${arrow} [${linkLabel}] ${otherNode.summary}`)
        );
      }
    }
    console.log();
  }
}
