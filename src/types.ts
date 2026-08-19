export type Tool = Record<string, any>;

export interface Node {
  id: string;
  service?: string;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

export interface Need {
  name: string;
  type: string;
  description: string;
}

export interface Provide {
  path: string;
  leafName: string;
  type: string;
  description: string;
  entityContext: string | null;
}

export interface IndexedTool {
  slug: string;
  name: string;
  description: string;
  tool: Tool;
  needs: Need[];
  provides: Provide[];
}

export interface ScoredCandidate {
  slug: string;
  name: string;
  provides: string[];
  score: number;
}

export interface Leftover {
  consumer: string;
  consumerName: string;
  param: string;
  entity: string | null;
  reason: "none" | "ambiguous" | "weak";
  candidates: ScoredCandidate[];
}

export interface MatchResult {
  edges: Edge[];
  leftovers: Leftover[];
}
