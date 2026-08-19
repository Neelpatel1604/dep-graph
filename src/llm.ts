import OpenAI from "openai";
import type { Edge, Leftover } from "./types";

const FALLBACK_BASE = "https://litmus-production.up.railway.app/proxy/openai/v1";
const DEFAULT_MODEL = "openai/gpt-4o";
const BATCH_SIZE = 4;
const MAX_BATCHES = 16;
const MIN_CONFIDENCE = 0.6;

function modelId(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

const SYSTEM_PROMPT = `You infer tool-to-tool dependency edges for an API toolkit catalog.
An edge means: run producer first so its output can fill a required input on the consumer.
Return JSON only: { "edges": [{ "from": "PRODUCER_SLUG", "to": "CONSUMER_SLUG", "label": "consumer_param", "confidence": 0.0 }] }
Rules:
- Never create edges for user/session fields (owner, repo, org, body, title, message, page, sort, head, base, branch, token).
- label MUST be the consumer parameter name given to you.
- from and to MUST be slugs from the candidate list (or the consumer itself is never a from).
- Multiple producers for one field are allowed.
- Prefer LIST/GET/CREATE/FIND tools of the same entity over unrelated tools.
- Do not invent slugs.
- If none of the candidates can produce the field, return no edge for that need.`;

function client(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || FALLBACK_BASE,
    timeout: 30_000,
    maxRetries: 1,
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function refineLeftovers(leftovers: Leftover[]): Promise<Edge[]> {
  if (leftovers.length === 0) return [];
  const openai = client();
  if (!openai) {
    console.error("LLM skipped: OPENAI_API_KEY not set");
    return [];
  }

  const model = modelId();
  console.error(`llm model: ${model}`);

  const prioritized = [
    ...leftovers.filter((l) => l.reason === "none"),
    ...leftovers.filter((l) => l.reason === "ambiguous"),
    ...leftovers.filter((l) => l.reason === "weak"),
  ].slice(0, BATCH_SIZE * MAX_BATCHES);

  const batches = chunk(prioritized, BATCH_SIZE);
  const edges: Edge[] = [];

  for (const batch of batches) {
    const payload = batch.map((l) => ({
      consumer: l.consumer,
      consumerName: l.consumerName,
      param: l.param,
      entity: l.entity,
      reason: l.reason,
      candidates: l.candidates.slice(0, 12).map((c) => ({
        slug: c.slug,
        name: c.name,
        provides: c.provides.slice(0, 8),
        score: c.score,
      })),
    }));

    try {
      const response = await openai.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ needs: payload }),
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(text) as { edges?: any[] };
      const allowed = new Map<string, Set<string>>();
      for (const item of batch) {
        allowed.set(
          `${item.consumer}|${item.param}`,
          new Set(item.candidates.map((c) => c.slug)),
        );
      }
      for (const raw of parsed.edges ?? []) {
        const from = String(raw.from ?? "");
        const to = String(raw.to ?? "");
        const label = String(raw.label ?? "");
        const confidence = Number(raw.confidence ?? 0);
        if (!from || !to || !label || from === to) continue;
        if (confidence < MIN_CONFIDENCE) continue;
        const ok = allowed.get(`${to}|${label}`);
        if (!ok || !ok.has(from)) continue;
        edges.push({ from, to, label });
      }
    } catch (err) {
      console.error(`LLM batch failed: ${(err as Error).message}`);
    }
  }

  return edges;
}
