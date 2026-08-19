import { extractNeeds, extractProvides, singularize, slugOf, toSnake, USER_CONTEXT } from "./schema";
import type {
  Edge,
  IndexedTool,
  Leftover,
  MatchResult,
  Node,
  Provide,
  ScoredCandidate,
  Tool,
} from "./types";

const STOP_WORDS = new Set([
  "github",
  "gitlab",
  "slack",
  "linear",
  "jira",
  "list",
  "get",
  "create",
  "update",
  "delete",
  "add",
  "remove",
  "set",
  "check",
  "abort",
  "accept",
  "merge",
  "find",
  "search",
  "fetch",
  "push",
  "enable",
  "disable",
  "approve",
  "request",
  "review",
  "an",
  "a",
  "the",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "from",
  "by",
  "and",
  "or",
  "authenticated",
  "public",
  "private",
  "selected",
  "multiple",
]);

const NUMBER_ENTITIES = new Set([
  "issue",
  "pull_request",
  "milestone",
  "alert",
  "gist",
]);

const LIST_VERB = /_(LIST|FIND|SEARCH)(_|$)/;
const GET_CREATE_VERB = /_(GET|CREATE)(_|$)/;

export function canonicalizeEntity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = singularize(toSnake(raw));
  s = s.replace(/_requests?$/, "_request");
  if (s === "pull" || s === "pr" || s === "pulls") return "pull_request";
  if (s === "pull_request") return "pull_request";
  if (s === "issues") return "issue";
  if (s === "hook" || s === "webhook") return "hook";
  if (s === "run" || s === "workflowrun") return "workflow_run";
  if (s === "workflow_run") return "workflow_run";
  if (s === "sha" || s === "commit") return "commit";
  if (s === "repo" || s === "repository") return "repository";
  if (!s || s.length < 2) return null;
  return s;
}

export function semanticEntity(param: string): string | null {
  const snake = toSnake(param);
  if (/issue_number|issue_id|^issue$/.test(snake)) return "issue";
  if (/pull_number|pull_id|pull_request|pr_number/.test(snake)) return "pull_request";
  if (/comment_id|comment_number/.test(snake)) return "comment";
  if (/run_id|workflow_run/.test(snake)) return "workflow_run";
  if (/hook_id|webhook_id/.test(snake)) return "hook";
  if (/migration/.test(snake)) return "migration";
  if (/gist_id/.test(snake)) return "gist";
  if (/release_id/.test(snake)) return "release";
  if (/milestone_number|milestone_id/.test(snake)) return "milestone";
  if (/review_id/.test(snake)) return "review";
  if (/deployment_id/.test(snake)) return "deployment";
  if (/installation_id/.test(snake)) return "installation";
  if (/artifact_id/.test(snake)) return "artifact";
  if (/job_id/.test(snake)) return "job";
  if (/workflow_id/.test(snake)) return "workflow";
  if (/alert_number|alert_id/.test(snake)) return "alert";
  if (/sha$/.test(snake) && snake !== "node_sha") return "commit";

  const stripped = snake
    .replace(/_ids$/, "")
    .replace(/_id$/, "")
    .replace(/_numbers$/, "")
    .replace(/_number$/, "")
    .replace(/_sha$/, "")
    .replace(/_uuid$/, "");
  if (stripped && stripped !== snake) {
    return canonicalizeEntity(stripped);
  }
  return null;
}

function primaryEntityFromSlug(slug: string): string | null {
  const withoutToolkit = slug.replace(/^[A-Z][A-Z0-9]+_/, "");
  const parts = toSnake(withoutToolkit)
    .split("_")
    .filter((p) => p && !STOP_WORDS.has(p));
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const prev = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (/^requests?$/.test(last) && /pull/.test(prev)) return "pull_request";
  if (last === "run" || prev === "workflow") return "workflow_run";
  return canonicalizeEntity(last);
}

function entityFromDescription(desc: string): string | null {
  const d = desc.toLowerCase();
  if (/\bpull request\b|\bpr number\b/.test(d)) return "pull_request";
  if (/\bissue number\b|\bthe issue\b|\bissue id\b/.test(d)) return "issue";
  if (/\bcomment\b/.test(d)) return "comment";
  if (/\bworkflow run\b|\brun id\b/.test(d)) return "workflow_run";
  if (/\bmigration\b/.test(d)) return "migration";
  if (/\bmilestone\b/.test(d)) return "milestone";
  if (/\bwebhook\b|\bhook id\b/.test(d)) return "hook";
  if (/\brelease\b/.test(d)) return "release";
  if (/\bcommit sha\b|\bhead sha\b/.test(d)) return "commit";
  return null;
}

function resolveProvideEntity(provide: Provide, slug: string): string | null {
  const fromPath = canonicalizeEntity(provide.entityContext);
  if (fromPath) return fromPath;
  const fromDesc = entityFromDescription(provide.description);
  if (fromDesc) return fromDesc;
  return primaryEntityFromSlug(slug);
}

function expectedLeaves(entity: string): Set<string> {
  if (NUMBER_ENTITIES.has(entity)) return new Set(["number", "id", `${entity}_number`, `${entity}_id`]);
  if (entity === "commit") return new Set(["sha", "id"]);
  return new Set(["id", `${entity}_id`, "node_id"]);
}

function slugHasEntity(slug: string, entity: string): boolean {
  const s = slug.toUpperCase();
  if (entity === "issue") return /ISSUES?/.test(s) && !/ISSUE_COMMENT/.test(s);
  if (entity === "pull_request") return /PULL/.test(s);
  if (entity === "comment") return /COMMENT/.test(s);
  if (entity === "workflow_run") return /WORKFLOW_RUN|_RUNS?\b|_A_WORKFLOW_RUN/.test(s);
  if (entity === "hook") return /HOOK/.test(s);
  const token = entity.replace(/_/g, "_").toUpperCase();
  return s.includes(token);
}

function unrelatedSlug(slug: string, entity: string): boolean {
  if (slugHasEntity(slug, entity)) return false;
  const other = ["ISSUE", "PULL", "COMMENT", "MILESTONE", "GIST", "RELEASE", "WORKFLOW", "HOOK", "MIGRATION"];
  const hits = other.filter((t) => slug.toUpperCase().includes(t));
  return hits.length > 0;
}

export function inferService(tool: Tool, slug: string): string | undefined {
  if (/ISSUE/i.test(slug)) return "issues";
  if (/PULL/i.test(slug)) return "pulls";
  if (/WORKFLOW|RUNNER|ARTIFACT|JOB/i.test(slug)) return "actions";
  if (/GIST/i.test(slug)) return "gists";
  if (/HOOK/i.test(slug)) return "hooks";
  if (/RELEASE/i.test(slug)) return "releases";
  return undefined;
}

export function indexTools(tools: Tool[]): IndexedTool[] {
  const indexed: IndexedTool[] = [];
  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug) continue;
    indexed.push({
      slug,
      name: String(tool.name ?? slug),
      description: String(tool.description ?? ""),
      tool,
      needs: extractNeeds(tool),
      provides: extractProvides(tool),
    });
  }
  return indexed;
}

function provideSummary(p: Provide, entity: string | null): string {
  return entity ? `${entity}.${p.leafName}` : p.path;
}

function isWeakParam(param: string, entity: string | null): boolean {
  if (!entity) return true;
  const snake = toSnake(param);
  return /repository_id|environment_name|org_id|organization_id|repo_id/.test(snake);
}

function scoreProducer(
  consumerSlug: string,
  param: string,
  entity: string,
  producer: IndexedTool,
): { score: number; hits: Provide[] } {
  if (producer.slug === consumerSlug) return { score: 0, hits: [] };
  const snakeParam = toSnake(param);
  const wantLeaves = expectedLeaves(entity);
  let best = 0;
  const hits: Provide[] = [];

  for (const leaf of producer.provides) {
    const leafSnake = toSnake(leaf.leafName);
    const leafEntity = resolveProvideEntity(leaf, producer.slug);
    let score = 0;
    const exactName =
      leafSnake === snakeParam ||
      leaf.path.toLowerCase().split(/[.\[]/).includes(snakeParam);

    if (exactName) score += 3;
    const numberLeaf =
      NUMBER_ENTITIES.has(entity) &&
      leafSnake === "number" &&
      (leafEntity === entity || !leafEntity);
    const typedId =
      leafEntity === entity &&
      (wantLeaves.has(leafSnake) || leafSnake === `${entity}_id` || leafSnake === `${entity}_number`);
    const genericId = !NUMBER_ENTITIES.has(entity) && wantLeaves.has(leafSnake);

    const leafMatchesId = exactName || numberLeaf || typedId || genericId;
    if (!leafMatchesId && score < 3) continue;

    if (leafEntity === entity) score += 2;
    else if (leafEntity && leafEntity !== entity) score -= 2;

    if (slugHasEntity(producer.slug, entity)) score += 2;
    if (LIST_VERB.test(producer.slug)) score += 2;
    else if (GET_CREATE_VERB.test(producer.slug)) score += 1;
    if (leaf.path.includes("[]")) score += 2;
    if (primaryEntityFromSlug(producer.slug) === entity) score += 1;

    const blob = `${leaf.description} ${producer.description}`.toLowerCase();
    const entityWords = entity.replace(/_/g, " ");
    if (blob.includes(entityWords) || blob.includes(entity)) score += 1;

    if (!leaf.entityContext && leafSnake === "id") score -= 2;
    if (unrelatedSlug(producer.slug, entity)) score -= 2;

    if (score > 0) {
      hits.push(leaf);
      if (score > best) best = score;
    }
  }

  return { score: best, hits };
}

function pickTopProducers(scored: ScoredCandidate[], n: number): ScoredCandidate[] {
  const eligible = scored.filter((c) => c.score >= 2);
  const picked: ScoredCandidate[] = [];
  const take = (pred: (c: ScoredCandidate) => boolean, max: number) => {
    let added = 0;
    for (const c of eligible) {
      if (picked.length >= n || added >= max) return;
      if (picked.some((p) => p.slug === c.slug)) continue;
      if (pred(c)) {
        picked.push(c);
        added++;
      }
    }
  };
  take((c) => /_LIST_/.test(c.slug), 2);
  take((c) => /_CREATE_/.test(c.slug), 1);
  take((c) => /_GET_/.test(c.slug) && !/EVENT/.test(c.slug), 1);
  take((c) => /_FIND_|_SEARCH_/.test(c.slug), 1);
  take(() => true, n);
  return picked;
}

export function matchDependencies(indexed: IndexedTool[]): MatchResult {
  const edges: Edge[] = [];
  const leftovers: Leftover[] = [];

  for (const consumer of indexed) {
    for (const need of consumer.needs) {
      const entity = semanticEntity(need.name);
      const scored: ScoredCandidate[] = [];

      if (entity) {
        for (const producer of indexed) {
          const { score, hits } = scoreProducer(
            consumer.slug,
            need.name,
            entity,
            producer,
          );
          if (score <= 0) continue;
          scored.push({
            slug: producer.slug,
            name: producer.name,
            provides: hits.map((h) =>
              provideSummary(h, resolveProvideEntity(h, producer.slug)),
            ),
            score,
          });
        }
      }

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const al = LIST_VERB.test(a.slug) ? 1 : 0;
        const bl = LIST_VERB.test(b.slug) ? 1 : 0;
        return bl - al;
      });
      const accepted = pickTopProducers(scored, 5);
      for (const c of accepted) {
        edges.push({ from: c.slug, to: consumer.slug, label: need.name });
      }

      const top = scored[0];
      const second = scored[1];
      const weak = isWeakParam(need.name, entity);
      const none = accepted.length === 0;
      const ambiguous =
        !!top &&
        !!second &&
        Math.abs(top.score - second.score) <= 1 &&
        accepted.length > 0;

      if (none || ambiguous || weak) {
        let candidates = scored.slice(0, 15);
        if (candidates.length < 8 && entity) {
          const extras: ScoredCandidate[] = [];
          for (const producer of indexed) {
            if (producer.slug === consumer.slug) continue;
            if (!slugHasEntity(producer.slug, entity)) continue;
            if (candidates.some((c) => c.slug === producer.slug)) continue;
            extras.push({
              slug: producer.slug,
              name: producer.name,
              provides: producer.provides
                .slice(0, 8)
                .map((p) => provideSummary(p, resolveProvideEntity(p, producer.slug))),
              score: LIST_VERB.test(producer.slug) ? 2 : GET_CREATE_VERB.test(producer.slug) ? 1 : 0,
            });
            if (candidates.length + extras.length >= 12) break;
          }
          candidates = [...candidates, ...extras].slice(0, 15);
        }

        leftovers.push({
          consumer: consumer.slug,
          consumerName: consumer.name,
          param: need.name,
          entity,
          reason: none ? "none" : weak ? "weak" : "ambiguous",
          candidates,
        });
      }
    }
  }

  return { edges, leftovers };
}

export function buildNodes(indexed: IndexedTool[]): Node[] {
  return indexed.map((t) => {
    const service = inferService(t.tool, t.slug);
    return service ? { id: t.slug, service } : { id: t.slug };
  });
}

export function cleanEdges(edges: Edge[], slugs: Set<string>): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    if (!slugs.has(e.from) || !slugs.has(e.to)) continue;
    const label = e.label ?? "";
    if (label && USER_CONTEXT.has(toSnake(label))) continue;
    const key = `${e.from}|${e.to}|${label}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: e.to, label: label || undefined });
  }
  return out;
}
