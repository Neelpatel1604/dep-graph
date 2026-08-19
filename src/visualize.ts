import { writeFileSync } from "fs";
import type { Graph } from "./types";

function filteredGraph(graph: Graph): Graph {
  const keepLabels = new Set(["issue_number", "pull_number", "comment_id"]);
  const edges = graph.edges.filter((e) => keepLabels.has(String(e.label ?? "").toLowerCase()));
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.from);
    ids.add(e.to);
  }
  const nodes = graph.nodes.filter((n) => ids.has(n.id));
  return { nodes, edges };
}

export function writeVisualization(graph: Graph, path = "visualization.html"): void {
  const sub = filteredGraph(graph);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tool dependency graph (issues / pulls)</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; }
    header { padding: 12px 16px; border-bottom: 1px solid #8884; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    p { margin: 0; font-size: 12px; opacity: 0.75; }
    #graph { width: 100%; height: 72vh; display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #8883; }
    code { font-size: 11px; }
  </style>
</head>
<body>
  <header>
    <h1>Dependency subgraph: issue_number / pull_number / comment_id</h1>
    <p>${sub.nodes.length} nodes, ${sub.edges.length} edges — full graph is in dependency_graph.json</p>
  </header>
  <svg id="graph"></svg>
  <table>
    <thead><tr><th>from</th><th>label</th><th>to</th></tr></thead>
    <tbody>
      ${sub.edges
        .slice()
        .sort((a, b) => String(a.label).localeCompare(String(b.label)) || a.from.localeCompare(b.from))
        .map(
          (e) =>
            `<tr><td><code>${e.from}</code></td><td>${e.label}</td><td><code>${e.to}</code></td></tr>`,
        )
        .join("\n")}
    </tbody>
  </table>
  <script>
    const data = ${JSON.stringify(sub)};
    const svg = document.getElementById("graph");
    const W = () => svg.clientWidth || window.innerWidth;
    const H = () => svg.clientHeight || Math.floor(window.innerHeight * 0.72);
    const nodes = data.nodes.map((n, i) => ({
      ...n,
      x: 0.5 + Math.cos((i / Math.max(data.nodes.length, 1)) * Math.PI * 2) * 0.35,
      y: 0.5 + Math.sin((i / Math.max(data.nodes.length, 1)) * Math.PI * 2) * 0.35,
    }));
    const index = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
    function render() {
      const w = W(), h = H();
      const colors = { issues: "#3b82f6", pulls: "#a855f7", default: "#64748b" };
      let links = "";
      for (const e of data.edges) {
        const a = nodes[index[e.from]], b = nodes[index[e.to]];
        if (!a || !b) continue;
        const x1 = a.x * w, y1 = a.y * h, x2 = b.x * w, y2 = b.y * h;
        links += \`<line x1="\${x1}" y1="\${y1}" x2="\${x2}" y2="\${y2}" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arr)"/>\`;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        links += \`<text x="\${mx}" y="\${my}" font-size="9" fill="#64748b">\${e.label}</text>\`;
      }
      let dots = "";
      for (const n of nodes) {
        const fill = colors[n.service] || colors.default;
        dots += \`<g transform="translate(\${n.x * w},\${n.y * h})">
          <circle r="6" fill="\${fill}" />
          <text x="8" y="4" font-size="10">\${n.id.replace(/^GITHUB_/, "")}</text>
        </g>\`;
      }
      svg.setAttribute("viewBox", \`0 0 \${w} \${h}\`);
      svg.innerHTML = \`<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#94a3b8"/></marker></defs>\${links}\${dots}\`;
    }
    render();
    window.addEventListener("resize", render);
  </script>
</body>
</html>
`;
  writeFileSync(path, html, "utf-8");
}
