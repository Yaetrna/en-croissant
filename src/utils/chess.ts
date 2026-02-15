import { type Outcome, type Score, type Token, commands } from "@/bindings";
import type { DrawShape } from "@lichess-org/chessground/draw";
import {
  type Color,
  type Move,
  type Role,
  makeSquare,
  makeUci,
  parseUci,
} from "chessops";
import { Chess, castlingSide, normalizeMove } from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { isPawns, parseComment } from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";
import { match } from "ts-pattern";
import { ANNOTATION_INFO, NAG_INFO, isBasicAnnotation } from "./annotation";
import { parseSanOrUci, positionFromFen } from "./chessops";
import { harmonicMean, isPrefix, mean } from "./misc";
import { INITIAL_SCORE, formatScore, getAccuracy, getCPLoss } from "./score";
import {
  type GameHeaders,
  type TreeNode,
  type TreeState,
  createNode,
  defaultTree,
  getNodeAtPath,
} from "./treeReducer";
import { unwrap } from "./unwrap";

export interface BestMoves {
  depth: number;
  score: Score;
  uciMoves: string[];
  sanMoves: string[];
  multipv: number;
  nps: number;
}

export interface MoveAnalysis {
  best: BestMoves[];
  novelty: boolean;
  is_sacrifice: boolean;
}

// copied from chessops
export const makeClk = (seconds: number): string => {
  let s = Math.max(0, seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  s = (s % 3600) % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${s.toLocaleString(
    "en",
    {
      minimumIntegerDigits: 2,
      maximumFractionDigits: 3,
    },
  )}`;
};

export function getMoveText(
  tree: TreeNode,
  opt: {
    glyphs: boolean;
    comments: boolean;
    extraMarkups: boolean;
    isFirst?: boolean;
  },
): string {
  const isBlack = tree.halfMoves % 2 === 0;
  const moveNumber = Math.ceil(tree.halfMoves / 2);
  let moveText = "";

  if (tree.san) {
    if (isBlack) {
      if (opt.isFirst) {
        moveText += `${moveNumber}... `;
      }
    } else {
      moveText += `${moveNumber}. `;
    }
    moveText += tree.san;
    if (opt.glyphs) {
      for (const annotation of tree.annotations) {
        if (annotation === "") continue;
        moveText += isBasicAnnotation(annotation)
          ? annotation
          : ` $${ANNOTATION_INFO[annotation].nag}`;
      }
    }
    moveText += " ";
  }

  if (opt.comments || opt.extraMarkups) {
    let content = "{";

    if (opt.extraMarkups) {
      if (tree.score !== null) {
        if (tree.score.value.type === "cp") {
          content += `[%eval ${formatScore(tree.score.value)}] `;
        } else {
          content += `[%eval #${tree.score.value.value}] `;
        }
      }
      if (tree.clock !== undefined) {
        content += `[%clk ${makeClk(tree.clock)}] `;
      }
    }

    if (opt.extraMarkups && tree.shapes.length > 0) {
      const squares = tree.shapes.filter((shape) => shape.dest === undefined);
      const arrows = tree.shapes.filter((shape) => shape.dest !== undefined);

      if (squares.length > 0) {
        content += `[%csl ${squares
          .map((shape) => {
            return (shape.brush ?? "G")[0].toUpperCase() + shape.orig;
          })
          .join(",")}]`;
      }
      if (arrows.length > 0) {
        content += `[%cal ${arrows
          .map((shape) => {
            return (shape.brush ?? "G")[0].toUpperCase() + shape.orig + shape.dest;
          })
          .join(",")}]`;
      }
    }

    if (opt.comments && tree.comment !== "") {
      content += tree.comment;
    }
    content += "} ";

    if (content !== "{} ") {
      moveText += content;
    }
  }
  return moveText;
}

export function getLastMainlinePosition(root: TreeNode): number[] {
  const position = [];
  for (let node = root; node.children.length > 0; node = node.children[0]) {
    if (node.move) {
      position.push(0);
    }
  }
  return position;
}

export function getMainLine(root: TreeNode, is960: boolean): string[] {
  return getVariationLine(root, getLastMainlinePosition(root), is960, true);
}

// outputs the correct uci move for castling in chess960 and standard chess
export function uciNormalize(chess: Chess, move: Move, chess960?: boolean) {
  const side = castlingSide(chess, move);
  const frcMove = normalizeMove(chess, move);
  if (side && !chess960) {
    const standardMove = match(makeUci(frcMove))
      .with("e1h1", () => "e1g1")
      .with("e1a1", () => "e1c1")
      .with("e8h8", () => "e8g8")
      .with("e8a8", () => "e8c8")
      .otherwise((v) => v);
    return standardMove;
  }
  return makeUci(frcMove);
}

export function getVariationLine(
  root: TreeNode,
  position: number[],
  chess960?: boolean,
  includeLastMove = false,
): string[] {
  const moves = [];
  let node = root;
  const [chess] = positionFromFen(root.fen);
  if (!chess) {
    return [];
  }
  for (const pos of position) {
    node = node.children[pos];
    if (node.move) {
      moves.push(uciNormalize(chess, node.move, chess960));
      chess.play(node.move);
    }
  }
  if (includeLastMove && node.children.length > 0) {
    moves.push(uciNormalize(chess, node.children[0].move!, chess960));
  }
  return moves;
}

function headersToPGN(game: GameHeaders): string {
  let headers = `[Event "${game.event || "?"}"]
[Site "${game.site || "?"}"]
[Date "${game.date || "????.??.??"}"]
[Round "${game.round || "?"}"]
[White "${game.white || "?"}"]
[Black "${game.black || "?"}"]
[Result "${game.result}"]
`;
  if (game.white_elo) {
    headers += `[WhiteElo "${game.white_elo}"]\n`;
  }
  if (game.black_elo) {
    headers += `[BlackElo "${game.black_elo}"]\n`;
  }
  if (game.start && game.start.length > 0) {
    headers += `[Start "${JSON.stringify(game.start)}"]\n`;
  }
  if (game.orientation) {
    headers += `[Orientation "${game.orientation}"]\n`;
  }
  if (game.time_control) {
    headers += `[TimeControl "${game.time_control}"]\n`;
  }
  if (game.white_time_control) {
    headers += `[WhiteTimeControl "${game.white_time_control}"]\n`;
  }
  if (game.black_time_control) {
    headers += `[BlackTimeControl "${game.black_time_control}"]\n`;
  }
  if (game.eco) {
    headers += `[ECO "${game.eco}"]\n`;
  }
  if (game.variant) {
    headers += `[Variant "${game.variant}"]\n`;
  }
  return headers;
}

export function defaultPGN() {
  return `[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n*`;
}

export function getPGN(
  tree: TreeNode,
  {
    headers,
    glyphs,
    comments,
    variations,
    extraMarkups,
    root = true,
    path = null,
  }: {
    headers: GameHeaders | null;
    glyphs: boolean;
    comments: boolean;
    variations: boolean;
    extraMarkups: boolean;
    root?: boolean;
    path?: number[] | null;
  },
): string {
  if (path && path.length === 0) {
    return "";
  }
  // Use array-based building to avoid O(N²) string concatenation
  const parts: string[] = [];
  if (headers) {
    parts.push(headersToPGN(headers));
  }
  if (root && tree.fen !== INITIAL_FEN) {
    parts.push('[SetUp "1"]\n');
    parts.push(`[FEN "${tree.fen}"]\n`);
  }
  parts.push("\n");

  // Iterative serialization using an explicit stack to avoid deep recursion
  const stack: { node: TreeNode; isRoot: boolean; path: number[] | null }[] = [
    { node: tree, isRoot: root, path },
  ];

  while (stack.length > 0) {
    const { node: current, isRoot, path: currentPath } = stack.pop()!;

    if (currentPath && currentPath.length === 0) {
      continue;
    }

    if (isRoot && current.comment !== null) {
      parts.push(getMoveText(current, { glyphs, comments, extraMarkups }));
    }

    if (current.children.length > 0) {
      const childIdx = currentPath ? currentPath[0] : 0;
      const child = current.children[childIdx];
      parts.push(
        getMoveText(child, {
          glyphs,
          comments,
          extraMarkups,
          isFirst: isRoot,
        }),
      );

      if (!currentPath && variations) {
        for (let vi = 1; vi < current.children.length; vi++) {
          const variation = current.children[vi];
          parts.push(" (");
          parts.push(
            getMoveText(variation, {
              glyphs,
              comments,
              extraMarkups,
              isFirst: true,
            }),
          );
          parts.push(" ");
          parts.push(
            getPGN(variation, {
              headers: null,
              glyphs,
              comments,
              variations,
              extraMarkups,
              root: false,
              path: null,
            }),
          );
          parts.push(") ");
        }
      }

      // Continue with the main line child (push to stack for iterative traversal)
      stack.push({
        node: child,
        isRoot: false,
        path: currentPath ? currentPath.slice(1) : null,
      });
    }
  }

  if (root && headers) {
    parts.push(` ${headers.result}`);
  }
  return parts.join("").trim();
}

export function parseKeyboardMove(san: string, fen: string) {
  function cleanSan(san: string) {
    if (san.length > 2) {
      const cleanedSan = san
        .replace(/^([kqbnr])/i, (_, match) => match.toUpperCase())
        .replace("o-o-o", "O-O-O")
        .replace("o-o", "O-O");
      return cleanedSan;
    }
    return san;
  }

  const [pos] = positionFromFen(fen);
  if (!pos) {
    return null;
  }
  const move = parseSanOrUci(pos, san);
  if (move) {
    return move;
  }
  const newSan = cleanSan(san);
  const newMove = parseSanOrUci(pos, newSan);
  if (newMove) {
    return newMove;
  }
  return null;
}

export async function getOpening(
  root: TreeNode,
  position: number[],
): Promise<string> {
  const tree = getNodeAtPath(root, position);
  if (tree === null) {
    return "";
  }
  const res = await commands.getOpeningFromFen(tree.fen);
  if (res.status === "error") {
    if (position.length === 0) {
      return "";
    }
    return getOpening(root, position.slice(0, -1));
  }
  return res.data;
}

function innerParsePGN(
  tokens: Token[],
  fen: string = INITIAL_FEN,
  halfMoves = 0,
  startIndex = 0,
  endIndex?: number,
  initialPos?: Chess,
): { tree: TreeState; endPos: number } {
  const end = endIndex ?? tokens.length;

  // Maintain a running Chess position to avoid re-parsing FEN on every move.
  // This is the single biggest performance win: eliminates positionFromFen() per move.
  let pos: Chess;
  if (initialPos) {
    pos = initialPos.clone();
  } else {
    const setup = parseFen(fen).unwrap();
    const result = Chess.fromSetup(setup);
    if (result.isErr) {
      return { tree: defaultTree(fen), endPos: end };
    }
    pos = result.unwrap();
  }

  // Pass turn directly to defaultTree to avoid another positionFromFen() call
  const tree = defaultTree(fen, pos.turn);
  let root = tree.root;
  let prevNode = root;
  root.halfMoves = halfMoves;

  if (halfMoves === 0 && pos.turn === "black") {
    root.halfMoves += 1;
  }

  // Keep a reference to the position before the current move,
  // so variations can branch from it.
  let prevPos: Chess = pos.clone();

  let i = startIndex;
  while (i < end) {
    const token = tokens[i];

    if (token.type === "Comment") {
      const comment = parseComment(token.value);

      if (comment.evaluation) {
        if (isPawns(comment.evaluation)) {
          root.score = {
            value: {
              type: "cp",
              value: comment.evaluation.pawns * 100,
            },
            wdl: null,
          };
        } else {
          root.score = {
            value: {
              type: "mate",
              value: comment.evaluation.mate,
            },
            wdl: null,
          };
        }
      }

      if (comment.shapes.length > 0) {
        const shapes: DrawShape[] = comment.shapes.map((shape) => ({
          orig: makeSquare(shape.from),
          dest: makeSquare(shape.to),
          brush: shape.color,
        }));
        root.shapes.push(...shapes);
      }

      if (comment.clock) {
        root.clock = comment.clock;
      }

      root.comment = comment.text;
      i++;
    } else if (token.type === "ParenOpen") {
      // Skip the ParenOpen and find the matching ParenClose using index-based scanning
      i++;
      const varStart = i;
      let subvariations = 0;
      while (i < end) {
        if (tokens[i].type === "ParenOpen") {
          subvariations++;
        } else if (tokens[i].type === "ParenClose") {
          if (subvariations === 0) break;
          subvariations--;
        }
        i++;
      }
      // Parse the variation passing the cloned parent position directly
      // This avoids re-parsing prevNode.fen from scratch
      const { tree: newTree } = innerParsePGN(
        tokens,
        prevNode.fen,
        root.halfMoves - 1,
        varStart,
        i,
        prevPos,
      );
      if (newTree.root.children.length > 0) {
        prevNode.children.push(newTree.root.children[0]);
      }
      i++; // skip ParenClose
    } else if (token.type === "ParenClose") {
      i++;
    } else if (token.type === "Nag") {
      root.annotations.push(NAG_INFO.get(token.value) || "");
      root.annotations.sort((a, b) => {
        return ANNOTATION_INFO[a].nag - ANNOTATION_INFO[b].nag;
      });
      i++;
    } else if (token.type === "San") {
      // Use the running position directly — no positionFromFen() call!
      let move = parseSan(pos, token.value);
      if (!move) {
        move = parseUci(token.value);
        if (!move) {
          i++;
          continue;
        }
      }
      const san = makeSan(pos, move);

      // Save prev position before playing the move
      prevPos = pos.clone();
      pos.play(move);

      const newTree = createNode({
        fen: makeFen(pos.toSetup()),
        move,
        san,
        halfMoves: root.halfMoves + 1,
      });
      root.children.push(newTree);

      prevNode = root;
      root = newTree;
      i++;
    } else if (token.type === "Outcome") {
      break;
    } else {
      i++;
    }
  }
  return { tree, endPos: i };
}

export async function parsePGN(
  pgn: string,
  initialFen?: string,
): Promise<TreeState> {
  const tokens = unwrap(await commands.lexPgn(pgn));

  const headers = getPgnHeaders(tokens);
  const fen = initialFen?.trim() || headers.fen.trim();

  const [pos] = positionFromFen(fen);

  const { tree } = innerParsePGN(
    tokens,
    fen,
    pos?.turn === "black" ? 1 : 0,
    0,
    undefined,
    pos ?? undefined,
  );
  tree.headers = headers;
  tree.position = headers.start ?? [];
  return tree;
}

function getPgnHeaders(tokens: Token[]): GameHeaders {
  const headersN = new Map<string, string>();

  for (const token of tokens) {
    if (token.type === "Header") {
      const { tag, value } = token.value;
      headersN.set(tag, value);
    } else if (token.type === "Outcome") {
      headersN.set("Result", token.value);
    }
  }

  const {
    Black,
    White,
    BlackElo,
    WhiteElo,
    // biome-ignore lint/suspicious/noShadowRestrictedNames: this is a name from the PGN standard
    Date,
    Site,
    Event,
    Result,
    FEN,
    Round,
    Start,
    Orientation,
    TimeControl,
    Variant,
  } = Object.fromEntries(headersN);

  const isValidOutcome = (value: string): value is Outcome => {
    return ["*", "1-0", "0-1", "1/2-1/2"].includes(value);
  };

  const isValidOrientation = (value: string): value is "white" | "black" => {
    return ["white", "black"].includes(value);
  };

  const headers: GameHeaders = {
    id: 0,
    fen: FEN ?? INITIAL_FEN,
    result: isValidOutcome(Result) ? Result : "*",
    black: Black ?? "?",
    white: White ?? "?",
    round: Round ?? "?",
    black_elo: BlackElo ? Number.parseInt(BlackElo) : 0,
    white_elo: WhiteElo ? Number.parseInt(WhiteElo) : 0,
    date: Date ?? "",
    site: Site ?? "",
    event: Event ?? "",
    start: (() => {
      try {
        return JSON.parse(Start ?? "[]");
      } catch {
        return [];
      }
    })(),
    orientation: isValidOrientation(Orientation) ? Orientation : "white",
    time_control: TimeControl,
    variant: Variant,
  };
  return headers;
}

type ColorMap<T> = {
  [key in Color]: T;
};

export function getGameStats(root: TreeNode) {
  const whiteAnnotations = {
    "??": 0,
    "?": 0,
    "?!": 0,
    "!!": 0,
    "!": 0,
    "!?": 0,
  };

  const blackAnnotations = {
    "??": 0,
    "?": 0,
    "?!": 0,
    "!!": 0,
    "!": 0,
    "!?": 0,
  };

  if (root.children.length === 0) {
    return {
      whiteCPL: 0,
      blackCPL: 0,
      whiteAccuracy: 0,
      blackAccuracy: 0,
      whiteAnnotations,
      blackAnnotations,
    };
  }

  let prevScore: Score = root.score ?? INITIAL_SCORE;
  const cplosses: ColorMap<number[]> = {
    white: [],
    black: [],
  };
  const accuracies: ColorMap<number[]> = {
    white: [],
    black: [],
  };
  let node = root;
  while (node.children.length > 0) {
    node = node.children[0];
    for (const annotation of node.annotations) {
      if (isBasicAnnotation(annotation)) {
        if (node.halfMoves % 2 === 1) {
          whiteAnnotations[annotation]++;
        } else {
          blackAnnotations[annotation]++;
        }
      }
    }
    const color = node.halfMoves % 2 === 1 ? "white" : "black";
    if (node.score) {
      cplosses[color].push(getCPLoss(prevScore.value, node.score.value, color));
      accuracies[color].push(
        getAccuracy(prevScore.value, node.score.value, color),
      );
      prevScore = node.score;
    }
  }
  const whiteCPL = mean(cplosses.white);
  const blackCPL = mean(cplosses.black);
  const whiteAccuracy = harmonicMean(accuracies.white);
  const blackAccuracy = harmonicMean(accuracies.black);

  return {
    whiteCPL,
    blackCPL,
    whiteAccuracy,
    blackAccuracy,
    whiteAnnotations,
    blackAnnotations,
  };
}

export type PiecesCount = {
  p: number;
  n: number;
  b: number;
  r: number;
  q: number;
};

export function getMaterialDiff(fen: string) {
  const res = parseFen(fen);
  if (res.isErr) {
    return null;
  }
  const board = res.unwrap().board;
  const { white, black } = board;

  const pieceDiff = (piece: Role) =>
    white.intersect(board[piece]).size() - black.intersect(board[piece]).size();

  const pieces = {
    p: pieceDiff("pawn"),
    n: pieceDiff("knight"),
    b: pieceDiff("bishop"),
    r: pieceDiff("rook"),
    q: pieceDiff("queen"),
  };

  const diff =
    pieces.p * 1 + pieces.n * 3 + pieces.b * 3 + pieces.r * 5 + pieces.q * 9;

  return { pieces, diff };
}

export function stripClock(fen: string): string {
  return fen.split(" ").slice(0, -2).join(" ");
}

export function hasMorePriority(
  position1: number[],
  position2: number[],
): boolean {
  if (isPrefix(position1, position2)) {
    return true;
  }

  // remove common beggining of the arrays
  let i = 0;
  while (
    i < position1.length &&
    i < position2.length &&
    position1[i] === position2[i]
  ) {
    i++;
  }

  return position1[i] < position2[i];
}
