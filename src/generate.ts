/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. We append it after your
 *     run command, so reading the final argv entry works whatever else the command carries.
 *   - Write your graph to `dependency_graph.json` in the working directory.
 *   - LLM credentials: OPENAI_API_KEY / OPENAI_BASE_URL (grader-injected). Fallback base
 *     URL is the Litmus proxy. Model: openai/gpt-4o.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { refineLeftovers } from "./llm";
import { buildNodes, cleanEdges, indexTools, matchDependencies } from "./match";
import { slugOf } from "./schema";
import type { Graph, Tool } from "./types";
import { writeVisualization } from "./visualize";

const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";
const LITMUS_BASE = "https://litmus-production.up.railway.app/proxy/openai/v1";

/** Node does not load .env on its own. Grader-injected env wins over the file. */
function loadDotEnv(): void {
  const envPath = ".env";
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  if (!process.env.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = LITMUS_BASE;
}

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

async function generate(tools: Tool[]): Promise<Graph> {
  const indexed = indexTools(tools);
  const { edges: heuristicEdges, leftovers } = matchDependencies(indexed);
  console.error(
    `heuristic: ${heuristicEdges.length} edges, ${leftovers.length} leftover needs`,
  );

  let llmEdges: Graph["edges"] = [];
  try {
    llmEdges = await refineLeftovers(leftovers);
    console.error(`llm: ${llmEdges.length} extra edges`);
  } catch (err) {
    console.error(`llm failed, keeping heuristic graph: ${(err as Error).message}`);
  }

  const slugs = new Set(indexed.map((t) => t.slug));
  const edges = cleanEdges([...heuristicEdges, ...llmEdges], slugs);
  const nodes = buildNodes(indexed);

  if (nodes.length === 0) {
    return {
      nodes: tools
        .map(slugOf)
        .filter((s): s is string => !!s)
        .map((id) => ({ id })),
      edges: [],
    };
  }

  return { nodes, edges };
}

async function main() {
  loadDotEnv();
  const tools = loadCatalog();
  const graph = await generate(tools);
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  writeVisualization(graph, tools);
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
