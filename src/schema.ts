import type { Need, Provide, Tool } from "./types";

export const USER_CONTEXT = new Set([
  "owner",
  "repo",
  "org",
  "organization",
  "body",
  "title",
  "name",
  "message",
  "description",
  "state",
  "q",
  "query",
  "username",
  "login",
  "branch",
  "head",
  "base",
  "sort",
  "page",
  "per_page",
  "perpage",
  "direction",
  "order",
  "token",
  "access_token",
  "accesstoken",
  "password",
  "secret",
  "commit_title",
  "commit_message",
  "merge_method",
  "draft",
  "color",
  "content",
  "text",
  "note",
  "reason",
  "email",
  "path",
  "since",
  "until",
  "before",
  "after",
  "filter",
  "affiliation",
  "visibility",
  "permission",
  "role",
  "privacy",
  "scope",
  "homepage",
  "private",
  "archived",
  "allow_squash_merge",
  "maintainer_can_modify",
]);

const SKIP_DEFS =
  /^(User|SimpleUser|Organization|License|Reactions|GitHubApp|App|Author|Actor|Permissions|Plan|CommunityProfile|GpgKey|Email|Link|Href|HypermediaLink)$/i;

const GENERIC_SEGMENTS = new Set([
  "data",
  "error",
  "successful",
  "success",
  "items",
  "result",
  "response",
  "payload",
  "value",
  "values",
]);

export function toSnake(name: string): string {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function singularize(word: string): string {
  const s = toSnake(word);
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (s.endsWith("ses") && s.length > 4) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) return s.slice(0, -1);
  return s;
}

export function isDependencyCandidate(
  param: string,
  type: string,
  desc: string,
): boolean {
  const snake = toSnake(param);
  if (USER_CONTEXT.has(snake)) return false;
  if (/(^|_)token$/.test(snake) || snake.includes("password")) return false;
  if (/(_id|_number|^id$|^sha$|uuid|migration)/i.test(snake)) return true;
  if (/Id$/.test(param) && param !== "clientMutationId") return true;
  if (
    (type === "integer" || type === "number") &&
    /number|identifier|\bid\b/i.test(desc)
  ) {
    return true;
  }
  return false;
}

export function isIdentifierLeaf(name: string): boolean {
  const snake = toSnake(name);
  return /(_id|_number|^id$|^number$|^sha$|^node_id$|uuid|migration)/i.test(
    snake,
  );
}

function entityFromPath(path: string): string | null {
  const segs = path
    .split(/\.|\[\]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !GENERIC_SEGMENTS.has(toSnake(s)));
  if (segs.length < 2) return null;
  const parent = segs[segs.length - 2];
  const snake = singularize(parent);
  if (!snake || GENERIC_SEGMENTS.has(snake)) return null;
  return snake;
}

function isLeafSchema(schema: any): boolean {
  if (!schema || typeof schema !== "object") return true;
  if (schema.$ref || schema.properties || schema.items) return false;
  if (schema.allOf || schema.anyOf || schema.oneOf) return false;
  const t = schema.type;
  return (
    t === "string" ||
    t === "integer" ||
    t === "number" ||
    t === "boolean" ||
    t === "null"
  );
}

export function flattenSchema(
  schema: any,
  defs: Record<string, any> = {},
  prefix = "",
  seen: Set<string> = new Set(),
  depth = 0,
): Provide[] {
  if (!schema || typeof schema !== "object" || depth > 8) return [];

  const localDefs = { ...defs, ...(schema.$defs ?? schema.definitions ?? {}) };

  if (schema.$ref) {
    const ref = String(schema.$ref);
    const name = ref.split("/").pop() ?? "";
    if (SKIP_DEFS.test(name)) return [];
    const key = `${prefix}#${name}`;
    if (seen.has(key)) return [];
    const next = new Set(seen);
    next.add(key);
    const resolved = localDefs[name];
    if (!resolved) return [];
    return flattenSchema(resolved, localDefs, prefix, next, depth + 1);
  }

  const out: Provide[] = [];

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const part of schema[key]) {
        out.push(
          ...flattenSchema(part, localDefs, prefix, new Set(seen), depth + 1),
        );
      }
    }
  }

  if (schema.items) {
    const arrayPath = prefix ? `${prefix}[]` : "[]";
    out.push(
      ...flattenSchema(schema.items, localDefs, arrayPath, new Set(seen), depth + 1),
    );
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const propSchema = prop as any;
      if (isLeafSchema(propSchema)) {
        out.push({
          path,
          leafName: key,
          type: String(propSchema.type ?? "unknown"),
          description: String(propSchema.description ?? ""),
          entityContext: entityFromPath(path),
        });
      } else {
        out.push(
          ...flattenSchema(
            propSchema,
            localDefs,
            path,
            new Set(seen),
            depth + 1,
          ),
        );
      }
    }
  }

  return out;
}

export function extractNeeds(tool: Tool): Need[] {
  const schema = tool.inputParameters ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties ?? {};
  const needs: Need[] = [];
  for (const name of required) {
    const prop = props[name] ?? {};
    const type = String(prop.type ?? "");
    const description = String(prop.description ?? "");
    if (!isDependencyCandidate(name, type, description)) continue;
    needs.push({ name, type, description });
  }
  return needs;
}

export function extractProvides(tool: Tool): Provide[] {
  const schema = tool.outputParameters ?? {};
  const defs = schema.$defs ?? schema.definitions ?? {};
  const leaves = flattenSchema(schema, defs);
  const seen = new Set<string>();
  const out: Provide[] = [];
  for (const leaf of leaves) {
    if (!isIdentifierLeaf(leaf.leafName)) continue;
    const key = `${leaf.path}|${leaf.leafName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(leaf);
  }
  return out;
}

export function slugOf(tool: Tool): string | undefined {
  const slug = tool.slug ?? tool.name ?? tool.function?.name;
  return slug ? String(slug) : undefined;
}
