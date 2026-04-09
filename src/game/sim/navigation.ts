import type { CellKey, Vec2 } from '../types';

export interface NavigationGrid {
  gridSize: number;
  walkable: Set<CellKey>;
  hardBlockers: Set<CellKey>;
  widthCells: number;
  heightCells: number;
}

export function parseCellKey(key: string): { col: number; row: number } | null {
  const [colRaw, rowRaw] = key.split(',');
  const col = Number(colRaw);
  const row = Number(rowRaw);
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) {
    return null;
  }
  return { col, row };
}

export function toCellKey(col: number, row: number): CellKey {
  return `${col},${row}`;
}

export function createNavigationGrid(contract: {
  gridSize: number;
  movement: {
    walkMasks: { lr: readonly string[]; up: readonly string[]; down: readonly string[] };
    blockers: { hard: readonly string[] };
  };
}): NavigationGrid {
  const walkable = new Set<CellKey>();
  const hardBlockers = new Set<CellKey>();
  let maxCol = 0;
  let maxRow = 0;

  const allWalk = [
    ...(contract.movement.walkMasks.lr || []),
    ...(contract.movement.walkMasks.up || []),
    ...(contract.movement.walkMasks.down || []),
  ];

  allWalk.forEach((key) => {
    const cell = parseCellKey(key);
    if (!cell) {
      return;
    }
    walkable.add(key as CellKey);
    maxCol = Math.max(maxCol, cell.col);
    maxRow = Math.max(maxRow, cell.row);
  });

  (contract.movement.blockers.hard || []).forEach((key) => {
    const cell = parseCellKey(key);
    if (!cell) {
      return;
    }
    hardBlockers.add(key as CellKey);
    maxCol = Math.max(maxCol, cell.col);
    maxRow = Math.max(maxRow, cell.row);
  });

  hardBlockers.forEach((key) => {
    walkable.delete(key);
  });

  return {
    gridSize: contract.gridSize,
    walkable,
    hardBlockers,
    widthCells: maxCol + 1,
    heightCells: maxRow + 1,
  };
}

export function worldToCell(point: Vec2, gridSize: number): CellKey {
  const col = Math.max(0, Math.floor(point.x / gridSize));
  const row = Math.max(0, Math.floor(point.y / gridSize));
  return toCellKey(col, row);
}

export function cellToWorldCenter(cell: CellKey, gridSize: number): Vec2 {
  const parsed = parseCellKey(cell);
  if (!parsed) {
    return { x: 0, y: 0 };
  }
  return {
    x: (parsed.col + 0.5) * gridSize,
    y: (parsed.row + 0.5) * gridSize,
  };
}

function getNeighbors(cell: CellKey): CellKey[] {
  const parsed = parseCellKey(cell);
  if (!parsed) {
    return [];
  }

  return [
    toCellKey(parsed.col + 1, parsed.row),
    toCellKey(parsed.col - 1, parsed.row),
    toCellKey(parsed.col, parsed.row + 1),
    toCellKey(parsed.col, parsed.row - 1),
  ];
}

export function findPathBfs(grid: NavigationGrid, start: CellKey, goal: CellKey): CellKey[] {
  if (start === goal) {
    return [start];
  }

  if (!grid.walkable.has(start) || !grid.walkable.has(goal)) {
    return [];
  }

  const queue: CellKey[] = [start];
  const visited = new Set<CellKey>([start]);
  const previous = new Map<CellKey, CellKey>();

  while (queue.length > 0) {
    const current = queue.shift() as CellKey;

    for (const neighbor of getNeighbors(current)) {
      if (!grid.walkable.has(neighbor) || visited.has(neighbor)) {
        continue;
      }

      visited.add(neighbor);
      previous.set(neighbor, current);

      if (neighbor === goal) {
        const reversed: CellKey[] = [goal];
        let step: CellKey | undefined = goal;
        while (step && step !== start) {
          step = previous.get(step);
          if (step) {
            reversed.push(step);
          }
        }
        return reversed.reverse();
      }

      queue.push(neighbor);
    }
  }

  return [];
}

export function findNearestWalkableCell(grid: NavigationGrid, source: CellKey): CellKey | null {
  if (grid.walkable.has(source)) {
    return source;
  }

  const parsed = parseCellKey(source);
  if (!parsed) {
    return null;
  }

  for (let radius = 1; radius < 16; radius += 1) {
    for (let row = parsed.row - radius; row <= parsed.row + radius; row += 1) {
      for (let col = parsed.col - radius; col <= parsed.col + radius; col += 1) {
        const key = toCellKey(col, row);
        if (grid.walkable.has(key)) {
          return key;
        }
      }
    }
  }

  return null;
}

export function pickRandomWalkableCell(grid: NavigationGrid): CellKey {
  const keys = Array.from(grid.walkable);
  if (keys.length === 0) {
    return '0,0';
  }

  const index = Math.floor(Math.random() * keys.length);
  return keys[index];
}
