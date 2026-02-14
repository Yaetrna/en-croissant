import type { Outcome, Score } from "@/bindings";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Move } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import type { Annotation } from "./annotation";
import { positionFromFen } from "./chessops";

export interface TreeState {
  root: TreeNode;
  headers: GameHeaders;
  position: number[];
  dirty: boolean;
  report: ReportState;
}

export interface TreeNode {
  fen: string;
  move: Move | null;
  san: string | null;
  children: TreeNode[];
  score: Score | null;
  depth: number | null;
  halfMoves: number;
  shapes: DrawShape[];
  annotations: Annotation[];
  comment: string;
  clock?: number;
}

export type ListNode = {
  position: number[];
  node: TreeNode;
};

export function* treeIterator(node: TreeNode): Generator<ListNode> {
  // Use a mutable path array and only copy on yield to avoid O(N*D) allocations
  const path: number[] = [];
  const stack: { node: TreeNode; childIndex: number; depth: number }[] = [];
  let current: TreeNode | null = node;
  let depth = 0;

  while (current !== null || stack.length > 0) {
    if (current !== null) {
      // Truncate path to current depth and yield
      path.length = depth;
      yield { position: path.slice(), node: current };

      if (current.children.length > 0) {
        // Push siblings (starting from last) onto stack for later
        for (let i = current.children.length - 1; i > 0; i--) {
          stack.push({ node: current.children[i], childIndex: i, depth: depth + 1 });
        }
        // Continue down the first child (main line)
        path.push(0);
        current = current.children[0];
        depth++;
      } else {
        current = null;
      }
    } else {
      const frame = stack.pop()!;
      depth = frame.depth;
      path.length = depth - 1;
      path.push(frame.childIndex);
      current = frame.node;
    }
  }
}

/**
 * Build a Map from FEN to position path for O(1) lookups.
 * Only stores the first occurrence of each FEN.
 */
export function buildFenIndex(node: TreeNode): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const { position, node: n } of treeIterator(node)) {
    if (!index.has(n.fen)) {
      index.set(n.fen, position);
    }
  }
  return index;
}

export function findFen(fen: string, node: TreeNode): number[] {
  // DFS search without materializing positions until match found
  const stack: { node: TreeNode; depth: number; childIndex: number }[] = [];
  const path: number[] = [];
  let current: TreeNode | null = node;
  let depth = 0;

  while (current !== null || stack.length > 0) {
    if (current !== null) {
      path.length = depth;
      if (current.fen === fen) {
        return path.slice();
      }
      if (current.children.length > 0) {
        for (let i = current.children.length - 1; i > 0; i--) {
          stack.push({ node: current.children[i], childIndex: i, depth: depth + 1 });
        }
        path.push(0);
        current = current.children[0];
        depth++;
      } else {
        current = null;
      }
    } else {
      const frame = stack.pop()!;
      depth = frame.depth;
      path.length = depth - 1;
      path.push(frame.childIndex);
      current = frame.node;
    }
  }
  return [];
}

export function* treeIteratorMainLine(node: TreeNode): Generator<ListNode> {
  const path: number[] = [];
  let current: TreeNode | undefined = node;
  let first = true;
  while (current) {
    if (!first) {
      path.push(0);
    }
    first = false;
    yield { position: path.slice(), node: current };
    current = current.children[0];
  }
}

export function countMainPly(node: TreeNode): number {
  let count = 0;
  let cur = node;
  while (cur.children.length > 0) {
    count++;
    cur = cur.children[0];
  }
  return count;
}

export function defaultTree(fen?: string, turn?: "white" | "black"): TreeState {
  // Allow passing turn directly to avoid redundant positionFromFen() call
  const resolvedTurn = turn ?? positionFromFen(fen ?? INITIAL_FEN)[0]?.turn ?? "white";

  return {
    dirty: false,
    position: [],
    root: {
      fen: fen?.trim() ?? INITIAL_FEN,
      move: null,
      san: null,
      children: [],
      score: null,
      depth: null,
      halfMoves: resolvedTurn === "black" ? 1 : 0,
      shapes: [],
      annotations: [],
      comment: "",
    },
    headers: {
      id: 0,
      fen: fen ?? INITIAL_FEN,
      black: "",
      white: "",
      result: "*",
      event: "",
      site: "",
    },
    report: {
      inProgress: false,
    },
  };
}

export function createNode({
  fen,
  move,
  san,
  halfMoves,
  clock,
}: {
  move: Move;
  san: string;
  fen: string;
  halfMoves: number;
  clock?: number;
}): TreeNode {
  return {
    fen,
    move,
    san,
    clock: clock ? clock / 1000 : undefined,
    children: [],
    score: null,
    depth: null,
    halfMoves,
    shapes: [],
    annotations: [],
    comment: "",
  };
}

export type GameHeaders = {
  id: number;
  fen: string;
  event: string;
  site: string;
  date?: string | null;
  time?: string | null;
  round?: string | null;
  white: string;
  white_elo?: number | null;
  black: string;
  black_elo?: number | null;
  result: Outcome;
  time_control?: string | null;
  white_time_control?: string | null;
  black_time_control?: string | null;
  eco?: string | null;
  variant?: string | null;
  // Repertoire headers
  start?: number[];
  orientation?: "white" | "black";
};

export function getGameName(headers: GameHeaders) {
  if (
    (headers.white && headers.white !== "?") ||
    (headers.black && headers.black !== "?")
  ) {
    return `${headers.white} - ${headers.black}`;
  }
  if (headers.event) {
    return headers.event;
  }
  return "Unknown";
}

export const getNodeAtPath = (node: TreeNode, path: number[]): TreeNode => {
  let currentNode = node;
  for (const index of path) {
    if (!currentNode.children || index >= currentNode.children.length) {
      return currentNode;
    }
    currentNode = currentNode.children[index];
  }
  return currentNode;
};

export interface ReportState {
  inProgress: boolean;
}
