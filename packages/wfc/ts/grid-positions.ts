export interface GridPosition {
  readonly q: number;
  readonly r: number;
  readonly s: number;
}

function cellsInRadius(radius: number): GridPosition[] {
  const cells: GridPosition[] = [];
  for (let q = -radius; q <= radius; q += 1) {
    const minR = Math.max(-radius, -q - radius);
    const maxR = Math.min(radius, -q + radius);
    for (let r = minR; r <= maxR; r += 1) {
      cells.push({ q, r, s: -q - r });
    }
  }
  return cells;
}

function distanceFromOrigin(pos: GridPosition): number {
  return (Math.abs(pos.q) + Math.abs(pos.r) + Math.abs(pos.s)) / 2;
}

export const ALL_GRID_POSITIONS: readonly GridPosition[] = cellsInRadius(2)
  .map((pos, index) => ({ pos, index }))
  .sort((a, b) => distanceFromOrigin(a.pos) - distanceFromOrigin(b.pos) || a.index - b.index)
  .map(({ pos }) => pos);

const GRID_INDEX_BY_KEY = new Map<string, number>(
  ALL_GRID_POSITIONS.map((pos, index) => [`${pos.q},${pos.r},${pos.s}`, index]),
);

export function gridIndexToPosition(gridIndex: number): GridPosition {
  const pos = ALL_GRID_POSITIONS[gridIndex];
  if (!pos) {
    throw new Error(`unknown grid index: ${gridIndex}`);
  }
  return pos;
}

export function gridPositionToIndex(q: number, r: number): number {
  const key = `${q},${r},${-q - r}`;
  const index = GRID_INDEX_BY_KEY.get(key);
  if (index === undefined) {
    throw new Error(`unknown grid position: ${q},${r}`);
  }
  return index;
}
