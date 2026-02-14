import { searchPosition } from "./db";
import { isPrefix } from "./misc";
import { type TreeNode, treeIterator } from "./treeReducer";

export type MissingMove = {
  position: number[];
  games: number;
  percentage: number;
  move: string;
};

export function getTreeStats(root: TreeNode) {
  let total = 0;
  let leafs = 0;
  let depth = 0;
  for (const item of treeIterator(root)) {
    total++;
    if (item.node.children.length === 0) {
      leafs++;
    }
    if (item.position.length > depth) {
      depth = item.position.length;
    }
  }
  // Subtract 1 to exclude the root node (matches original behavior)
  return { total: total - 1, leafs, depth };
}

export async function openingReport({
  color,
  start,
  root,
  referenceDb,
  setProgress,
  minimumGames,
  percentageCoverage,
}: {
  color: "white" | "black";
  start: number[];
  root: TreeNode;
  referenceDb: string;
  setProgress: React.Dispatch<React.SetStateAction<number>>;
  minimumGames: number;
  percentageCoverage: number;
}): Promise<MissingMove[]> {
  // Collect only the subset of nodes we actually need to query
  const candidates: { position: number[]; node: TreeNode }[] = [];
  const ignoredPrefixes: number[][] = [];

  for (const item of treeIterator(root)) {
    // Skip positions before the start
    if (isPrefix(item.position, start) && item.position.length < start.length) {
      continue;
    }

    // Skip opponent's turns
    if (
      (color === "white" && item.node.halfMoves % 2 === 0) ||
      (color === "black" && item.node.halfMoves % 2 === 1)
    ) {
      continue;
    }

    candidates.push({ position: item.position, node: item.node });
  }

  const missingMoves: MissingMove[] = [];

  // Process candidates - batch DB queries for better throughput
  const BATCH_SIZE = 10;
  for (let batch = 0; batch < candidates.length; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, candidates.length);
    const batchItems = candidates.slice(batch, batchEnd);

    const results = await Promise.all(
      batchItems.map(async (item) => {
        // Check if this position is under an ignored prefix
        for (const p of ignoredPrefixes) {
          if (isPrefix(p, item.position)) {
            return null;
          }
        }

        const [openings] = await searchPosition(
          {
            path: referenceDb,
            type: "exact",
            fen: item.node.fen,
            color: "white",
            player: null,
            result: "any",
          },
          "opening",
        );
        return { item, openings };
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { item, openings } = result;

      const total = openings.reduce(
        (acc, opening) => acc + opening.black + opening.white + opening.draw,
        0,
      );

      if (total < minimumGames) {
        ignoredPrefixes.push(item.position);
        continue;
      }

      const filteredOpenings = openings.filter(
        (opening) =>
          (opening.black + opening.white + opening.draw) / total >
          1 - percentageCoverage / 100,
      );

      for (const opening of filteredOpenings) {
        const child = item.node.children.find(
          (child) => child.san === opening.move,
        );
        if (!child && opening.move !== "*") {
          missingMoves.push({
            position: item.position,
            move: opening.move,
            games: opening.black + opening.white + opening.draw,
            percentage: (opening.black + opening.white + opening.draw) / total,
          });
        }
      }
    }

    setProgress((batchEnd / candidates.length) * 100);
  }

  return missingMoves;
}
