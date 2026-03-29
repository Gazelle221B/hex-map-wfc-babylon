export const TILE_RADIUS = 8;

const HEX_WIDTH = 2;
const HEX_HEIGHT = (2 / Math.sqrt(3)) * 2;
const GRID_DIR_N = 0;
const GRID_DIR_NE = 1;
const GRID_DIR_SE = 2;
const GRID_DIR_S = 3;
const GRID_DIR_SW = 4;
const GRID_DIR_NW = 5;

export function cubeKey(q, r, s = -q - r) {
  return `${q},${r},${s}`;
}

export function cellsInRadius(center, radius) {
  const cells = [];
  for (let q = -radius; q <= radius; q += 1) {
    const minR = Math.max(-radius, -q - radius);
    const maxR = Math.min(radius, -q + radius);
    for (let r = minR; r <= maxR; r += 1) {
      cells.push({
        q: center.q + q,
        r: center.r + r,
        s: center.s - q - r,
      });
    }
  }
  return cells;
}

export function logicalGridToOffset(q, r) {
  return {
    gridX: q,
    gridZ: r + Math.floor((q - (q & 1)) / 2),
  };
}

export function gridPositionToCenter(grid) {
  const gridX = grid.gridX ?? logicalGridToOffset(grid.gridQ, grid.gridR).gridX;
  const gridZ = grid.gridZ ?? logicalGridToOffset(grid.gridQ, grid.gridR).gridZ;
  const worldOffset = calculateWorldOffset(gridX, gridZ, TILE_RADIUS);
  const { col, row } = worldToOffset(worldOffset.x, worldOffset.z);
  return offsetToCube(col, row);
}

export function buildSinglePassGridDescriptors(grids) {
  return grids.map((grid) => {
    const center = gridPositionToCenter(grid);
    const cellKeys = new Set(cellsInRadius(center, TILE_RADIUS).map((cell) => cubeKey(cell.q, cell.r, cell.s)));
    return {
      ...grid,
      center,
      cellKeys,
    };
  });
}

export function bucketSinglePassResult(result, grids) {
  const descriptors = buildSinglePassGridDescriptors(grids);
  const tiles = result.tiles ?? [];
  const collapseOrder = result.collapseOrder ?? result.collapse_order ?? [];

  return descriptors.map((grid) => ({
    ...grid,
    tiles: tiles.filter((tile) => grid.cellKeys.has(cubeKey(tile.q, tile.r, tile.s ?? (-tile.q - tile.r)))),
    collapseOrder: collapseOrder.filter((tile) =>
      grid.cellKeys.has(cubeKey(tile.q, tile.r, tile.s ?? (-tile.q - tile.r)))),
  }));
}

function calculateWorldOffset(gridX, gridZ, gridRadius) {
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

function getGridWorldOffset(gridRadius, direction) {
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

function worldToOffset(worldX, worldZ) {
  const row = Math.round(worldZ / (HEX_HEIGHT * 0.75));
  const stagger = (Math.abs(row) % 2) * HEX_WIDTH * 0.5;
  const col = Math.round((worldX - stagger) / HEX_WIDTH);
  return { col, row };
}

function offsetToCube(col, row) {
  const q = col - Math.floor(row / 2);
  const r = row;
  return { q, r, s: -q - r };
}
