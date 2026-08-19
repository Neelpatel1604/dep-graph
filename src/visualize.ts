import { writeFileSync } from "fs";
import { isDependencyCandidate, slugOf, USER_CONTEXT, toSnake } from "./schema";
import type { Graph, Tool } from "./types";

interface Neighbor {
  slug: string;
  label: string;
}

interface Story {
  id: string;
  name: string;
  goal: string;
  user: string[];
  fromTool: string[];
  producers: Neighbor[];
  consumers: Neighbor[];
}

function splitRequired(tool: Tool | undefined): { user: string[]; fromTool: string[] } {
  const schema = tool?.inputParameters ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties ?? {};
  const user: string[] = [];
  const fromTool: string[] = [];
  for (const name of required) {
    const prop = props[name] ?? {};
    const type = String(prop.type ?? "");
    const description = String(prop.description ?? "");
    if (USER_CONTEXT.has(toSnake(name)) || !isDependencyCandidate(name, type, description)) {
      user.push(name);
    } else {
      fromTool.push(name);
    }
  }
  return { user, fromTool };
}

function short(id: string): string {
  return id.replace(/^[A-Z][A-Z0-9]+_/, "");
}

function producersFor(graph: Graph, slug: string): Neighbor[] {
  const seen = new Set<string>();
  const out: Neighbor[] = [];
  for (const e of graph.edges) {
    if (e.to !== slug) continue;
    const key = `${e.from}|${e.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug: e.from, label: e.label ?? "" });
  }
  return out;
}

function consumersFor(graph: Graph, slug: string): Neighbor[] {
  const seen = new Set<string>();
  const out: Neighbor[] = [];
  for (const e of graph.edges) {
    if (e.from !== slug) continue;
    const key = `${e.to}|${e.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug: e.to, label: e.label ?? "" });
  }
  return out;
}

function makeStory(
  graph: Graph,
  bySlug: Map<string, Tool>,
  id: string,
  goal: string,
): Story | null {
  if (!graph.nodes.some((n) => n.id === id)) return null;
  const tool = bySlug.get(id);
  const split = splitRequired(tool);
  return {
    id,
    name: String(tool?.name ?? short(id)),
    goal,
    user: split.user,
    fromTool: split.fromTool,
    producers: producersFor(graph, id),
    consumers: consumersFor(graph, id),
  };
}

function featuredStories(graph: Graph, bySlug: Map<string, Tool>): Story[] {
  const specs = [
    { id: "GITHUB_CREATE_AN_ISSUE_COMMENT", goal: "Agent wants to comment on an issue." },
    { id: "GITHUB_MERGE_A_PULL_REQUEST", goal: "Agent wants to merge a pull request." },
  ];
  return specs
    .map((s) => makeStory(graph, bySlug, s.id, s.goal))
    .filter((s): s is Story => !!s);
}

function browseTools(graph: Graph, bySlug: Map<string, Tool>): Story[] {
  const ids = [...new Set(graph.edges.flatMap((e) => [e.from, e.to]))].sort();
  return ids
    .map((id) => makeStory(graph, bySlug, id, `Dependencies for ${short(id)}.`))
    .filter((s): s is Story => !!s);
}

export function writeVisualization(
  graph: Graph,
  tools: Tool[] = [],
  path = "visualization.html",
): void {
  const bySlug = new Map<string, Tool>();
  for (const tool of tools) {
    const slug = slugOf(tool);
    if (slug) bySlug.set(slug, tool);
  }
  const stories = featuredStories(graph, bySlug);
  const browse = browseTools(graph, bySlug);
  const payload = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    stories,
    browse,
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>How the agent uses the dependency graph</title>
  <style>
    :root { --ink:#1b1f24; --muted:#5b6570; --line:#e7e9ee; --bg:#f4f5f7; --card:#fff; --accent:#1d4ed8; --prod:#2563eb; --cons:#0f766e; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: var(--bg); }
    .wrap { max-width: 920px; margin: 0 auto; padding: 28px 20px 64px; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    h2 { font-size: 20px; margin: 0 0 10px; }
    p { margin: 0 0 12px; color: var(--muted); }
    .steps { display: flex; gap: 8px; margin: 20px 0 24px; flex-wrap: wrap; }
    .steps button {
      border: 1px solid var(--line); background: var(--card); border-radius: 999px;
      padding: 6px 12px; cursor: pointer; font: inherit;
    }
    .steps button.on { background: var(--ink); color: #fff; border-color: var(--ink); }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .box { border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: #fafbfc; }
    .box h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .pill { display: inline-block; margin: 0 6px 6px 0; padding: 4px 8px; border-radius: 999px; background: #eef2ff; font-size: 13px; }
    .pill.user { background: #ecfdf3; }
    .flow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
    .node, .field {
      border: 1px solid var(--line); background: #fff; border-radius: 10px; padding: 10px 12px;
      font-family: ui-monospace, Consolas, monospace; font-size: 12px;
    }
    .node.main { border-color: var(--accent); background: #eff6ff; }
    .arrow { color: var(--muted); font-size: 20px; }
    .alts { margin-top: 14px; }
    .alts li { margin: 6px 0; font-size: 13px; }
    .mini-wrap { margin-top: 20px; border: 1px solid var(--line); border-radius: 12px; background: #fafbfc; padding: 12px; }
    .mini-wrap h3 { margin: 0 0 8px; font-size: 14px; color: var(--ink); }
    .mini-meta { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    svg.mini { width: 100%; height: auto; min-height: 220px; display: block; background: #fff; border-radius: 8px; }
    nav.bar { display: flex; justify-content: space-between; margin-top: 18px; }
    nav.bar button {
      background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px;
      cursor: pointer; font: inherit;
    }
    nav.bar button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    select { width: 100%; padding: 8px; border-radius: 8px; border: 1px solid var(--line); font: inherit; }
    .note { font-size: 13px; }
    @media (max-width: 700px) { .cols { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="steps" id="tabs"></div>
    <section class="card" id="view"></section>
    <nav class="bar">
      <button class="ghost" id="back">Back</button>
      <button id="next">Next</button>
    </nav>
  </div>
  <script>
    const data = ${JSON.stringify(payload)};
    const MAX_SIDE = 8;
    const short = (id) => id.replace(/^[A-Z][A-Z0-9]+_/, "");
    let step = 0;
    let storyId = (data.stories[0] && data.stories[0].id) || (data.browse[0] && data.browse[0].id);
    const labels = ["1. What this is", "2. User vs tool", "3. The chain", "4. Dependency map"];

    function story() {
      return data.stories.find((s) => s.id === storyId) || data.browse.find((s) => s.id === storyId) || data.browse[0];
    }
    function pills(list, cls) {
      if (!list.length) return "<span class='note'>None</span>";
      return list.map((x) => "<span class='pill " + cls + "'>" + x + "</span>").join("");
    }
    function chain(s) {
      const main = "<div class='node main'>" + short(s.id) + "</div>";
      const first = s.producers[0];
      if (!first) return "<p>No precursor tools found for this action.</p>" + main;
      return "<div class='flow'>" +
        "<div class='node'>" + short(first.slug) + "</div>" +
        "<span class='arrow'>→</span>" +
        "<div class='field'>" + first.label + "</div>" +
        "<span class='arrow'>→</span>" +
        main +
      "</div>";
    }
    function alts(s) {
      const rest = s.producers.slice(1, 6);
      if (!rest.length) return "";
      return "<div class='alts'><h3 class='note'>Also valid producers</h3><ul>" +
        rest.map((p) => "<li><code>" + short(p.slug) + "</code> supplies <code>" + p.label + "</code></li>").join("") +
        "</ul></div>";
    }
    function miniGraph(s) {
      const prod = s.producers.slice(0, MAX_SIDE);
      const cons = s.consumers.slice(0, MAX_SIDE);
      const extraP = s.producers.length - prod.length;
      const extraC = s.consumers.length - cons.length;
      const W = 880, H = Math.max(220, 60 + Math.max(prod.length, cons.length, 1) * 34);
      const cx = W / 2, cy = H / 2;
      const leftX = 24, rightX = W - 24;
      const place = (list, x) => list.map((item, i) => {
        const y = list.length === 1 ? cy : 36 + (i * (H - 72)) / Math.max(list.length - 1, 1);
        return { ...item, x, y };
      });
      const L = place(prod, leftX);
      const R = place(cons, rightX);
      let svg = '<svg class="mini" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
      svg += '<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#94a3b8"/></marker></defs>';
      const line = (x1, y1, x2, y2, label, color) => {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="1.2" marker-end="url(#arr)"/>' +
          '<text x="' + mx + '" y="' + (my - 4) + '" font-size="10" fill="#64748b" text-anchor="middle">' + label + '</text>';
      };
      for (const p of L) svg += line(p.x + 140, p.y, cx - 90, cy, p.label, '#2563eb');
      for (const c of R) svg += line(cx + 90, cy, c.x - 140, c.y, c.label, '#0f766e');
      const box = (x, y, text, fill, stroke) =>
        '<rect x="' + (x - 4) + '" y="' + (y - 14) + '" width="148" height="28" rx="6" fill="' + fill + '" stroke="' + stroke + '"/>' +
        '<text x="' + (x + 70) + '" y="' + y + '" font-size="10" font-family="Consolas,monospace" fill="#1b1f24" text-anchor="middle">' +
        (text.length > 22 ? text.slice(0, 20) + "…" : text) + '</text>';
      for (const p of L) svg += box(p.x, p.y, short(p.slug), '#eff6ff', '#2563eb');
      svg += box(cx - 74, cy, short(s.id), '#eff6ff', '#1d4ed8');
      svg += '<text x="' + cx + '" y="' + (cy - 22) + '" font-size="11" fill="#64748b" text-anchor="middle">selected slug</text>';
      for (const c of R) svg += box(c.x - 144, c.y, short(c.slug), '#ecfdf5', '#0f766e');
      if (!L.length && !R.length) {
        svg += '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" fill="#64748b" font-size="13">No tool-to-tool edges for this slug</text>';
      }
      svg += '</svg>';
      const meta = s.producers.length + " producer edge(s), " + s.consumers.length + " consumer edge(s)" +
        (extraP > 0 ? " · +" + extraP + " more producers" : "") +
        (extraC > 0 ? " · +" + extraC + " more consumers" : "");
      return '<div class="mini-wrap"><h3>Dependency neighborhood</h3>' +
        '<p class="mini-meta">Left = run first to fill IDs · center = <code>' + s.id + '</code> · right = tools that use its output</p>' +
        '<p class="mini-meta">' + meta + '</p>' + svg + '</div>';
    }
    function storyPicker(featuredOnly) {
      const list = featuredOnly ? data.stories : data.browse;
      return "<label class='note'>Tool slug</label><select id='pick'>" +
        list.map((s) => "<option value='" + s.id + "'" + (s.id === storyId ? " selected" : "") + ">" + s.name + " (" + short(s.id) + ")</option>").join("") +
        "</select>";
    }
    function render() {
      document.getElementById("tabs").innerHTML = labels.map((l, i) =>
        "<button class='" + (i === step ? "on" : "") + "' data-step='" + i + "'>" + l + "</button>"
      ).join("");
      const s = story();
      let html = "";
      if (step === 0) {
        html = "<h1>How an agent uses this graph</h1>" +
          "<p>Composio has many tools. Before the agent runs one, it must know: ask the user, or run another tool first to get an ID.</p>" +
          "<p>This page walks through that with the GitHub sample catalog. The <b>generator is not GitHub-only</b> — it reads whatever catalog you pass and matches ID fields like <code>*_id</code> / <code>*_number</code>.</p>" +
          "<p class='note'>Full graph: <b>" + data.nodes + "</b> tools, <b>" + data.edges + "</b> edges in dependency_graph.json.</p>";
      } else if (step === 1) {
        html = "<h2>What must be filled to run this tool?</h2>" + storyPicker(true) +
          "<p style='margin-top:12px'>" + (s.goal || "") + "</p>" +
          "<div class='cols'>" +
            "<div class='box'><h3>Ask the user</h3>" + pills(s.user, "user") + "<p class='note'>Not in the graph.</p></div>" +
            "<div class='box'><h3>Get from another tool</h3>" + pills(s.fromTool, "") + "<p class='note'>These become graph edges.</p></div>" +
          "</div>";
      } else if (step === 2) {
        html = "<h2>Run a precursor, then the action</h2>" +
          "<p>One example chain — the graph may list several valid producers.</p>" +
          chain(s) + alts(s);
      } else {
        html = "<h2>See dependencies for any slug</h2>" +
          "<p>Pick a tool. The small graph shows only its direct neighbors from dependency_graph.json.</p>" +
          storyPicker(false) +
          "<div style='margin-top:16px'></div>" +
          "<div class='cols'>" +
            "<div class='box'><h3>Ask the user</h3>" + pills(s.user, "user") + "</div>" +
            "<div class='box'><h3>Get from another tool</h3>" + pills(s.fromTool, "") + "</div>" +
          "</div>" +
          miniGraph(s);
      }
      document.getElementById("view").innerHTML = html;
      const pick = document.getElementById("pick");
      if (pick) pick.addEventListener("change", (e) => { storyId = e.target.value; render(); });
      document.getElementById("back").style.visibility = step === 0 ? "hidden" : "visible";
      document.getElementById("next").textContent = step === 3 ? "Start over" : "Next";
    }
    document.getElementById("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-step]");
      if (!b) return;
      step = Number(b.getAttribute("data-step"));
      render();
    });
    document.getElementById("back").onclick = () => { step = Math.max(0, step - 1); render(); };
    document.getElementById("next").onclick = () => { step = step === 3 ? 0 : step + 1; render(); };
    render();
  </script>
</body>
</html>
`;
  writeFileSync(path, html, "utf-8");
}
