import { DEFAULT_CONFIG } from "@hex/types";

export interface GridPosition {
  readonly q: number;
  readonly r: number;
  readonly s: number;
}

const HEX_WIDTH = 2;
const HEX_HEIGHT = (2 / Math.sqrt(3)) * 2;
const GRID_DIR_N = 0;
const GRID_DIR_NE = 1;
const GRID_DIR_SE = 2;
const GRID_DIR_S = 3;
const GRID_DIR_SW = 4;
const GRID_DIR_NW = 5;
const GRID_TILE_RADIUS = DEFAULT_CONFIG.gridRadius;

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

function compareGridPositions(a: GridPosition, b: GridPosition): number {
  return distanceFromOrigin(a) - distanceFromOrigin(b)
    || a.q - b.q
    || a.r - b.r
    || a.s - b.s;
}

// This explicit order is the cross-language gridIndex <-> (q, r, s) contract
// shared with packages/wfc/src/multi_grid.rs and used by placements.
export const ALL_GRID_POSITIONS: readonly GridPosition[] = cellsInRadius(2)
  .sort(compareGridPositions);

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

export function gridPositionToCenter(position: GridPosition): GridPosition {
  const { gridX, gridZ } = logicalGridToOffset(position.q, position.r);
  const worldOffset = calculateWorldOffset(gridX, gridZ, GRID_TILE_RADIUS);
  const { col, row } = worldToOffset(worldOffset.x, worldOffset.z);
  return offsetToCube(col, row);
}

export function gridIndexToCenter(gridIndex: number): GridPosition {
  return gridPositionToCenter(gridIndexToPosition(gridIndex));
}

function logicalGridToOffset(q: number, r: number): { gridX: number; gridZ: number } {
  return {
    gridX: q,
    gridZ: r + Math.floor((q - (q & 1)) / 2),
  };
}

function calculateWorldOffset(gridX: number, gridZ: number, gridRadius: number): { x: number; z: number } {
  if (gridX === 0 && gridZ === 0) {
    return { x: 0, z: 0 };
  }

  let totalX = 0;
  let totalZ = 0;
  let currentX = 0;
  let currentZ = 0;

  while (currentX !== gridX || currentZ !== gridZ) {
    const dx = gridX - currentX;
    const dz = gridZ - currentZ;
    const isOddCol = Math.abs(currentX) % 2 === 1;

    let direction = GRID_DIR_N;
    let nextX = currentX;
    let nextZ = currentZ;

    if (dx === 0) {
      direction = dz < 0 ? GRID_DIR_N : GRID_DIR_S;
      nextZ += dz < 0 ? -1 : 1;
    } else if (dx > 0) {
      if (dz < 0 || (dz === 0 && !isOddCol)) {
        direction = GRID_DIR_NE;
        nextX += 1;
        nextZ += isOddCol ? 0 : -1;
      } else {
        direction = GRID_DIR_SE;
        nextX += 1;
        nextZ += isOddCol ? 1 : 0;
      }
    } else if (dz < 0 || (dz === 0 && !isOddCol)) {
      direction = GRID_DIR_NW;
      nextX -= 1;
      nextZ += isOddCol ? 0 : -1;
    } else {
      direction = GRID_DIR_SW;
      nextX -= 1;
      nextZ += isOddCol ? 1 : 0;
    }

    const offset = getGridWorldOffset(gridRadius, direction);
    totalX += offset.x;
    totalZ += offset.z;
    currentX = nextX;
    currentZ = nextZ;
  }

  return { x: totalX, z: totalZ };
}

function getGridWorldOffset(gridRadius: number, direction: number): { x: number; z: number } {
  const diameter = gridRadius * 2 + 1;
  const gridWidth = diameter * HEX_WIDTH;
  const gridHeight = diameter * HEX_HEIGHT * 0.75;
  const half = HEX_WIDTH * 0.5;

  switch (direction) {
    case GRID_DIR_N:
      return { x: half, z: -gridHeight };
    case GRID_DIR_NE:
      return { x: gridWidth * 0.75 + half * 0.5, z: -gridHeight * 0.5 + half * 0.866 };
    case GRID_DIR_SE:
      return { x: gridWidth * 0.75 - half * 0.5, z: gridHeight * 0.5 + half * 0.866 };
    case GRID_DIR_S:
      return { x: -half, z: gridHeight };
    case GRID_DIR_SW:
      return { x: -gridWidth * 0.75 - half * 0.5, z: gridHeight * 0.5 - half * 0.866 };
    case GRID_DIR_NW:
      return { x: -gridWidth * 0.75 + half * 0.5, z: -gridHeight * 0.5 - half * 0.866 };
    default:
      throw new Error(`unknown grid direction: ${direction}`);
  }
}

function worldToOffset(worldX: number, worldZ: number): { col: number; row: number } {
  const row = Math.round(worldZ / (HEX_HEIGHT * 0.75));
  const stagger = (Math.abs(row) % 2) * HEX_WIDTH * 0.5;
  const col = Math.round((worldX - stagger) / HEX_WIDTH);
  return { col, row };
}

function offsetToCube(col: number, row: number): GridPosition {
  const q = col - Math.floor(row / 2);
  const r = row;
  return { q, r, s: -q - r };
}
