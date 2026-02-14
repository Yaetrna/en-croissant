import { createContext } from "react";

/**
 * Pre-built index mapping stripped FEN → all positions in the tree with that FEN.
 * Built once per root change in GameNotation, consumed by CompleteMoveCell for O(1) lookup.
 */
export const TranspositionContext = createContext<Map<string, number[][]>>(
  new Map(),
);
