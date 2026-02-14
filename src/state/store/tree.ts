import type { BestMoves, Outcome, Score } from "@/bindings";
import { ANNOTATION_INFO, type Annotation } from "@/utils/annotation";
import { getPGN } from "@/utils/chess";
import { parseSanOrUci, positionFromFen } from "@/utils/chessops";
import { isPrefix } from "@/utils/misc";
import { getAnnotation } from "@/utils/score";
import { playSound } from "@/utils/sound";
import {
  type GameHeaders,
  type TreeNode,
  type TreeState,
  createNode,
  defaultTree,
  getNodeAtPath,
} from "@/utils/treeReducer";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Move } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { produce } from "immer";
import { type StateCreator, createStore } from "zustand";
import { persist } from "zustand/middleware";
import { createDebouncedStorage } from "./treeStorage";

export interface TreeStoreState extends TreeState {
  currentNode: () => TreeNode;

  goToNext: () => void;
  goToPrevious: () => void;
  goToStart: () => void;
  goToEnd: () => void;
  goToMove: (move: number[]) => void;
  goToBranchStart: () => void;
  goToBranchEnd: () => void;
  nextBranch: () => void;
  previousBranch: () => void;
  nextBranching: () => void;
  previousBranching: () => void;

  goToAnnotation: (annotation: Annotation, color: "white" | "black") => void;

  makeMove: (args: {
    payload: string | Move;
    changePosition?: boolean;
    mainline?: boolean;
    clock?: number;
    changeHeaders?: boolean;
  }) => void;

  appendMove: (args: { payload: Move; clock?: number }) => void;

  makeMoves: (args: {
    payload: string[];
    mainline?: boolean;
    changeHeaders?: boolean;
  }) => void;
  deleteMove: (path?: number[]) => void;
  promoteVariation: (path: number[]) => void;
  promoteToMainline: (path: number[]) => void;
  copyVariationPgn: (path: number[]) => void;

  setStart: (start: number[]) => void;

  setAnnotation: (payload: Annotation) => void;
  setComment: (payload: string) => void;
  setHeaders: (payload: GameHeaders) => void;
  setResult: (payload: Outcome) => void;
  setShapes: (shapes: DrawShape[]) => void;
  setScore: (score: Score) => void;

  clearShapes: () => void;

  setFen: (fen: string) => void;

  addAnalysis: (
    analysis: {
      best: BestMoves[];
      novelty: boolean;
      is_sacrifice: boolean;
    }[],
  ) => void;

  setReportInProgress: (value: boolean) => void;

  setState: (state: TreeState) => void;
  reset: () => void;
  save: () => void;
}

export type TreeStore = ReturnType<typeof createTreeStore>;

export const createTreeStore = (id?: string, initialTree?: TreeState) => {
  const stateCreator: StateCreator<TreeStoreState> = (set, get) => ({
    ...(initialTree ?? defaultTree()),

    currentNode: () => getNodeAtPath(get().root, get().position),

    setState: (state) => {
      set(() => state);
    },

    reset: () =>
      set(() => {
        return defaultTree();
      }),

    save: () => {
      set((state) => ({
        ...state,
        dirty: false,
      }));
    },

    setFen: (fen) =>
      set((state) => ({
        ...state,
        dirty: true,
        root: defaultTree(fen).root,
        position: [],
      })),

    goToNext: () =>
      set((state) => {
        const node = getNodeAtPath(state.root, state.position);
        if (!node || node.children.length === 0) return state;
        const child = node.children[0];
        if (!child.san) return state;
        // Use pre-computed SAN to determine sound — no FEN parse needed
        playSound(child.san.includes("x"), child.san.includes("+"));
        return {
          ...state,
          position: [...state.position, 0],
        };
      }),
    goToPrevious: () =>
      set((state) => ({
        ...state,
        position: state.position.slice(0, -1),
      })),

    goToAnnotation: (annotation, color) =>
      set((state) => {
        const colorN = color === "white" ? 1 : 0;

        let p: number[] = [...state.position];
        let node = getNodeAtPath(state.root, p);
        while (true) {
          if (node.children.length === 0) {
            p = [];
          } else {
            p = [...p, 0];
          }

          node = getNodeAtPath(state.root, p);

          if (
            node.annotations.includes(annotation) &&
            node.halfMoves % 2 === colorN
          ) {
            break;
          }
        }

        return { ...state, position: p };
      }),

    makeMove: ({
      payload,
      changePosition,
      mainline,
      clock,
      changeHeaders = true,
    }) => {
      set((state) => {
        const curNode = getNodeAtPath(state.root, state.position);
        if (!curNode) return state;
        const [pos] = positionFromFen(curNode.fen);
        if (!pos) return state;

        let move: Move;
        if (typeof payload === "string") {
          const m = parseSan(pos, payload);
          if (!m) return state;
          move = m;
        } else {
          move = payload;
        }

        const san = makeSan(pos, move);
        if (san === "--") return state;

        // FAST PATH: move already exists as a child — just navigate, no tree clone
        const existingIdx = curNode.children.findIndex((n) => n.san === san);
        if (existingIdx !== -1) {
          playSound(san.includes("x"), san.includes("+"));
          if (changePosition === false) return state;
          return {
            ...state,
            position: [...state.position, existingIdx],
          };
        }

        // SLOW PATH: new move — clone tree and add node
        const newRoot = clonePath(state.root, state.position);
        const mutableState: TreeState = {
          root: newRoot,
          position: [...state.position],
          headers: { ...state.headers },
          dirty: state.dirty,
          report: state.report,
        };
        makeMoveOnTree({
          state: mutableState,
          move,
          last: false,
          changePosition,
          changeHeaders,
          mainline,
          clock,
        });
        return {
          ...state,
          root: mutableState.root,
          position: mutableState.position,
          headers: mutableState.headers,
          dirty: mutableState.dirty,
        };
      });
    },

    appendMove: ({ payload, clock }) =>
      set((state) => {
        // Find end of mainline for cloning
        const endPath: number[] = [];
        let n = state.root;
        while (n.children.length > 0) {
          endPath.push(0);
          n = n.children[0];
        }
        const newRoot = clonePath(state.root, endPath);
        const mutableState: TreeState = {
          root: newRoot,
          position: [...state.position],
          headers: { ...state.headers },
          dirty: state.dirty,
          report: state.report,
        };
        makeMoveOnTree({ state: mutableState, move: payload, last: true, clock });
        return {
          ...state,
          root: mutableState.root,
          position: mutableState.position,
          headers: mutableState.headers,
          dirty: mutableState.dirty,
        };
      }),

    makeMoves: ({ payload, mainline, changeHeaders = true }) =>
      set((state) => {
        let curNode = getNodeAtPath(state.root, state.position);
        if (!curNode) return state;
        const [pos] = positionFromFen(curNode.fen);
        if (!pos) return state;

        // Fast-path prefix: follow existing children without cloning
        let position = [...state.position];
        let fastIdx = 0;
        for (; fastIdx < payload.length; fastIdx++) {
          const m = parseSanOrUci(pos, payload[fastIdx]);
          if (!m) return state;
          const san = makeSan(pos, m);
          const childIdx = curNode.children.findIndex((n) => n.san === san);
          if (childIdx === -1) break; // need to add new nodes from here
          pos.play(m);
          position.push(childIdx);
          curNode = curNode.children[childIdx];
        }

        if (fastIdx === payload.length) {
          // All moves existed — just navigate, no tree mutation
          if (payload.length > 0) {
            const lastSan = curNode.san || "";
            playSound(lastSan.includes("x"), lastSan.includes("+"));
          }
          return { ...state, position };
        }

        // Slow path: clone tree from current position and add remaining moves
        const newRoot = clonePath(state.root, position);
        const mutableState: TreeState = {
          root: newRoot,
          position,
          headers: { ...state.headers },
          dirty: true,
          report: state.report,
        };
        for (let i = fastIdx; i < payload.length; i++) {
          const m = parseSanOrUci(pos, payload[i]);
          if (!m) break;
          pos.play(m);
          makeMoveOnTree({
            state: mutableState,
            move: m,
            last: false,
            mainline,
            sound: i === payload.length - 1,
            changeHeaders,
          });
        }
        return {
          ...state,
          root: mutableState.root,
          position: mutableState.position,
          headers: mutableState.headers,
          dirty: mutableState.dirty,
        };
      }),
    goToEnd: () =>
      set((state) => {
        const endPosition: number[] = [];
        let currentNode = state.root;
        while (currentNode.children.length > 0) {
          endPosition.push(0);
          currentNode = currentNode.children[0];
        }
        return { ...state, position: endPosition };
      }),
    goToStart: () =>
      set((state) => ({
        ...state,
        position: state.headers.start || [],
      })),
    goToMove: (move) =>
      set((state) => ({
        ...state,
        position: move,
      })),
    goToBranchStart: () => {
      set((state) => {
        let pos = state.position;
        if (
          pos.length > 0 &&
          pos[pos.length - 1] !== 0
        ) {
          pos = pos.slice(0, -1);
        }

        while (
          pos.length > 0 &&
          pos[pos.length - 1] === 0
        ) {
          pos = pos.slice(0, -1);
        }

        return { ...state, position: pos };
      });
    },

    goToBranchEnd: () => {
      set((state) => {
        const newPos = [...state.position];
        let currentNode = getNodeAtPath(state.root, newPos);
        while (currentNode.children.length > 0) {
          newPos.push(0);
          currentNode = currentNode.children[0];
        }
        return { ...state, position: newPos };
      });
    },

    nextBranch: () =>
      set((state) => {
        if (state.position.length === 0) return state;

        let pos = state.position;
        const parent = getNodeAtPath(state.root, pos.slice(0, -1));
        const branchIndex = pos[pos.length - 1];
        const node = parent.children[branchIndex];

        // Makes the navigation more fluid and compatible with next/previous branching
        if (node.children.length >= 2 && parent.children.length <= 1) {
          pos = [...pos, 0];
        }

        return {
          ...state,
          position: [
            ...pos.slice(0, -1),
            (branchIndex + 1) % parent.children.length,
          ],
        };
      }),
    previousBranch: () =>
      set((state) => {
        if (state.position.length === 0) return state;

        let pos = state.position;
        const parent = getNodeAtPath(state.root, pos.slice(0, -1));
        const branchIndex = pos[pos.length - 1];
        const node = parent.children[branchIndex];

        // Makes the navigation more fluid and compatible with next/previous branching
        if (node.children.length >= 2 && parent.children.length <= 1) {
          pos = [...pos, 0];
        }

        return {
          ...state,
          position: [
            ...pos.slice(0, -1),
            (branchIndex + parent.children.length - 1) % parent.children.length,
          ],
        };
      }),

    nextBranching: () =>
      set((state) => {
        let node = getNodeAtPath(state.root, state.position);
        let branchCount = node.children.length;

        if (branchCount === 0) return state;

        const newPos = [...state.position];
        do {
          newPos.push(0);
          node = node.children[0];
          branchCount = node.children.length;
        } while (branchCount === 1);

        return { ...state, position: newPos };
      }),

    previousBranching: () =>
      set((state) => {
        let node = getNodeAtPath(state.root, state.position);
        let branchCount = node.children.length;

        if (state.position.length === 0) return state;

        let newPos = [...state.position];
        do {
          newPos = newPos.slice(0, -1);
          node = getNodeAtPath(state.root, newPos);
          branchCount = node.children.length;
        } while (branchCount === 1 && newPos.length > 0);

        return { ...state, position: newPos };
      }),

    deleteMove: (path) =>
      set(
        produce((state) => {
          state.dirty = true;
          deleteMove(state, path ?? state.position);
        }),
      ),
    promoteVariation: (path) =>
      set(
        produce((state) => {
          state.dirty = true;
          promoteVariation(state, path);
        }),
      ),
    promoteToMainline: (path) =>
      set(
        produce((state) => {
          state.dirty = true;
          let p = path;
          while (p.some((v) => v !== 0)) {
            promoteVariation(state, p);
            p = state.position;
          }
        }),
      ),
    copyVariationPgn: (path) => {
      const { root } = get();
      const pgn = getPGN(root, {
        headers: null,
        comments: false,
        extraMarkups: false,
        glyphs: true,
        variations: false,
        path,
      });
      navigator.clipboard.writeText(pgn);
    },
    setStart: (start) =>
      set((state) => ({
        ...state,
        dirty: true,
        headers: { ...state.headers, start },
      })),
    setAnnotation: (payload) =>
      set((state) => {
        const newRoot = clonePath(state.root, state.position);
        const node = getNodeAtPath(newRoot, state.position);
        if (!node) return state;
        if (node.annotations.includes(payload)) {
          node.annotations = node.annotations.filter((a) => a !== payload);
        } else {
          const newAnnotations = node.annotations.filter(
            (a) =>
              !ANNOTATION_INFO[a].group ||
              ANNOTATION_INFO[a].group !== ANNOTATION_INFO[payload].group,
          );
          node.annotations = [...newAnnotations, payload].sort((a, b) =>
            ANNOTATION_INFO[a].nag > ANNOTATION_INFO[b].nag ? 1 : -1,
          );
        }
        return { ...state, root: newRoot, dirty: true };
      }),
    setComment: (payload) =>
      set((state) => {
        const newRoot = clonePath(state.root, state.position);
        const node = getNodeAtPath(newRoot, state.position);
        if (!node) return state;
        node.comment = payload;
        return { ...state, root: newRoot, dirty: true };
      }),
    setHeaders: (headers) =>
      set((state) => {
        if (headers.fen && headers.fen !== state.root.fen) {
          return {
            ...state,
            dirty: true,
            headers,
            root: defaultTree(headers.fen).root,
            position: [],
          };
        }
        return { ...state, dirty: true, headers };
      }),
    setResult: (result) =>
      set((state) => ({
        ...state,
        dirty: true,
        headers: { ...state.headers, result },
      })),
    setShapes: (shapes) =>
      set((state) => {
        const newRoot = clonePath(state.root, state.position);
        setShapes({ root: newRoot, position: state.position } as TreeState, shapes);
        return { ...state, root: newRoot, dirty: true };
      }),
    setScore: (score) =>
      set((state) => {
        const newRoot = clonePath(state.root, state.position);
        const node = getNodeAtPath(newRoot, state.position);
        if (!node) return state;
        node.score = score;
        return { ...state, root: newRoot, dirty: true };
      }),
    addAnalysis: (analysis) =>
      set(
        produce((state) => {
          state.dirty = true;
          addAnalysis(state, analysis);
        }),
      ),

    setReportInProgress: (value: boolean) => {
      set((state) => ({
        ...state,
        report: { ...state.report, inProgress: value },
      }));
    },

    clearShapes: () =>
      set((state) => {
        const node = getNodeAtPath(state.root, state.position);
        if (!node || node.shapes.length === 0) return state;
        const newRoot = clonePath(state.root, state.position);
        const clonedNode = getNodeAtPath(newRoot, state.position)!;
        clonedNode.shapes = [];
        return { ...state, root: newRoot, dirty: true };
      }),
  });

  if (id) {
    return createStore<TreeStoreState>()(
      persist(stateCreator, {
        name: id,
        storage: createDebouncedStorage<TreeStoreState>(),
        partialize: (state) => ({
          root: state.root,
          position: state.position,
          headers: state.headers,
          dirty: state.dirty,
          report: state.report,
        }) as TreeStoreState,
      }),
    );
  }

  return createStore<TreeStoreState>()(stateCreator);
};

/**
 * Clone nodes along a path for structural sharing.
 * Only nodes on the path are cloned; all others share references.
 */
function clonePath(root: TreeNode, path: number[]): TreeNode {
  const newRoot: TreeNode = { ...root, children: [...root.children] };
  let current = newRoot;
  for (const idx of path) {
    if (idx >= current.children.length) break;
    const clonedChild: TreeNode = {
      ...current.children[idx],
      children: [...current.children[idx].children],
    };
    current.children[idx] = clonedChild;
    current = clonedChild;
  }
  return newRoot;
}

function makeMoveOnTree({
  state,
  move,
  last,
  changePosition = true,
  changeHeaders = true,
  mainline = false,
  clock,
  sound = true,
}: {
  state: TreeState;
  move: Move;
  last: boolean;
  changePosition?: boolean;
  changeHeaders?: boolean;
  mainline?: boolean;
  clock?: number;
  sound?: boolean;
}) {
  // Find position: walk mainline for last=true, else use current
  let position: number[];
  let moveNode: TreeNode;
  if (last) {
    position = [];
    moveNode = state.root;
    while (moveNode.children.length > 0) {
      position.push(0);
      moveNode = moveNode.children[0];
    }
  } else {
    position = state.position;
    const node = getNodeAtPath(state.root, position);
    if (!node) return;
    moveNode = node;
  }
  const [pos] = positionFromFen(moveNode.fen);
  if (!pos) return;
  const san = makeSan(pos, move);
  if (san === "--") return; // invalid move
  pos.play(move);
  if (sound) {
    playSound(san.includes("x"), san.includes("+"));
  }
  if (changeHeaders && pos.isEnd()) {
    if (pos.isCheckmate()) {
      state.headers.result = pos.turn === "white" ? "0-1" : "1-0";
    }
    if (pos.isStalemate() || pos.isInsufficientMaterial()) {
      state.headers.result = "1/2-1/2";
    }
  }

  const newFen = makeFen(pos.toSetup());

  if (
    (changeHeaders && isThreeFoldRepetition(state, newFen)) ||
    is50MoveRule(state)
  ) {
    state.headers.result = "1/2-1/2";
  }

  const i = moveNode.children.findIndex((n) => n.san === san);
  if (i !== -1) {
    if (changePosition) {
      // Clone child for structural sharing (safe for subsequent mutations)
      moveNode.children[i] = {
        ...moveNode.children[i],
        children: [...moveNode.children[i].children],
      };
      if (state.position === position) {
        state.position.push(i);
      } else {
        state.position = [...position, i];
      }
    }
  } else {
    state.dirty = true;
    const newMoveNode = createNode({
      fen: newFen,
      move,
      san,
      halfMoves: moveNode.halfMoves + 1,
      clock,
    });
    if (mainline) {
      moveNode.children.unshift(newMoveNode);
    } else {
      moveNode.children.push(newMoveNode);
    }
    if (changePosition) {
      if (state.position === position) {
        if (mainline) {
          state.position.push(0);
        } else {
          state.position.push(moveNode.children.length - 1);
        }
      } else {
        state.position = [...position, moveNode.children.length - 1];
      }
    }
  }
}

function isThreeFoldRepetition(state: TreeState, fen: string) {
  let node = state.root;
  const fens = [INITIAL_FEN.split(" - ")[0]];
  for (const i of state.position) {
    node = node.children[i];
    fens.push(node.fen.split(" - ")[0]);
  }
  return fens.filter((f) => f === fen.split(" - ")[0]).length >= 2;
}

function is50MoveRule(state: TreeState) {
  let node = state.root;
  let count = 0;
  for (const i of state.position) {
    node = node.children[i];
    count += 1;
    if (node.san) {
      const ch = node.san.charCodeAt(0);
      // Pawn moves start with lowercase file letter (a-h = 97-104);
      // captures contain 'x'; promotions contain '='
      if (
        (ch >= 97 && ch <= 104) || // pawn move
        node.san.includes("x") || // capture
        node.san.includes("=") // promotion
      ) {
        count = 0;
      }
    }
  }
  return count >= 100;
}

function deleteMove(state: TreeState, path: number[]) {
  const node = getNodeAtPath(state.root, path);
  if (!node) return;
  const parent = getNodeAtPath(state.root, path.slice(0, -1));
  if (!parent) return;
  const index = parent.children.findIndex((n) => n === node);
  parent.children.splice(index, 1);
  if (isPrefix(path, state.position)) {
    state.position = path.slice(0, -1);
  } else if (isPrefix(path.slice(0, -1), state.position)) {
    if (state.position.length >= path.length) {
      state.position[path.length - 1] = 0;
    }
  }
}

function promoteVariation(state: TreeState, path: number[]) {
  // get last element different from 0
  const i = path.findLastIndex((v) => v !== 0);
  if (i === -1) return state;

  const v = path[i];
  const promotablePath = path.slice(0, i);
  const node = getNodeAtPath(state.root, promotablePath);
  if (!node) return state;
  node.children.unshift(node.children.splice(v, 1)[0]);
  state.position = path;
  state.position[i] = 0;
}

function setShapes(state: TreeState, shapes: DrawShape[]) {
  const node = getNodeAtPath(state.root, state.position);
  if (!node) return state;

  const [shape] = shapes;
  if (shape) {
    const index = node.shapes.findIndex(
      (s) => s.orig === shape.orig && s.dest === shape.dest,
    );

    if (index !== -1) {
      node.shapes.splice(index, 1);
    } else {
      node.shapes.push(shape);
    }
  } else {
    node.shapes = [];
  }

  return state;
}

function addAnalysis(
  state: TreeState,
  analysis: {
    best: BestMoves[];
    novelty: boolean;
    is_sacrifice: boolean;
  }[],
) {
  let cur = state.root;
  let i = 0;
  while (cur !== undefined && i < analysis.length) {
    const [pos] = positionFromFen(cur.fen);
    if (pos && !pos.isEnd() && analysis[i].best.length > 0) {
      cur.score = analysis[i].best[0].score;
      let prevScore = null;
      let prevprevScore = null;
      let prevMoves: BestMoves[] = [];
      if (i > 0) {
        prevScore = analysis[i - 1].best[0].score;
        prevMoves = analysis[i - 1].best;
      }
      if (i > 1) {
        prevprevScore = analysis[i - 2].best[0].score;
      }
      const curScore = analysis[i].best[0].score;
      const color = cur.halfMoves % 2 === 1 ? "white" : "black";
      const annotation = getAnnotation(
        prevprevScore?.value || null,
        prevScore?.value || null,
        curScore.value,
        color,
        prevMoves,
        analysis[i].is_sacrifice,
        cur.san || "",
      );
      if (annotation) {
        cur.annotations = [...cur.annotations, annotation];
      }
      if (analysis[i].novelty) {
        cur.annotations = [...cur.annotations, "N"];
      }
      cur.annotations = [...new Set(cur.annotations)];
      cur.annotations.sort((a, b) =>
        ANNOTATION_INFO[a].nag > ANNOTATION_INFO[b].nag ? 1 : -1,
      );
    }
    cur = cur.children[0];
    i++;
  }
}
