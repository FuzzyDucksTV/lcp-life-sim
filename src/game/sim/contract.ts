import houseLayout from '../../data/houseLayout.json';
import { houseRuntimeContract } from '../../data/houseRuntimeContract';
import type { CellKey } from '../types';
import { findNearestWalkableCell, toCellKey } from './navigation';
import type { NavigationGrid } from './navigation';

interface LayoutObject {
  id: string;
  type: string;
  x: number;
  y: number;
  scale: number;
}

interface WorldSize {
  width: number;
  height: number;
}

interface LayoutAnchor {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function readSize(value: unknown): WorldSize | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const width = asPositiveNumber((value as { width?: unknown }).width);
  const height = asPositiveNumber((value as { height?: unknown }).height);

  if (!width || !height) {
    return null;
  }

  return { width, height };
}

function getLayoutCanvasSizeFromExport(): WorldSize | null {
  const layout = houseLayout as {
    canvas?: unknown;
    coordinateSpace?: { canvas?: unknown };
    navigation?: { canvas?: unknown };
  };

  return (
    readSize(layout.canvas) ??
    readSize(layout.coordinateSpace?.canvas) ??
    readSize(layout.navigation?.canvas) ??
    null
  );
}

function getRuntimeSceneSizeFromContract(): WorldSize | null {
  const contract = runtimeContract as { scene?: unknown };
  return readSize(contract.scene) ?? null;
}

function getWorldSizeFromMasks(): WorldSize {
  const allKeys = [
    ...runtimeContract.movement.walkMasks.lr,
    ...runtimeContract.movement.walkMasks.up,
    ...runtimeContract.movement.walkMasks.down,
    ...runtimeContract.movement.blockers.hard,
    ...runtimeContract.movement.blockers.soft,
  ];

  let maxCol = 0;
  let maxRow = 0;
  allKeys.forEach((key) => {
    const [colRaw, rowRaw] = key.split(',');
    const col = Number(colRaw);
    const row = Number(rowRaw);
    if (Number.isInteger(col) && Number.isInteger(row)) {
      maxCol = Math.max(maxCol, col);
      maxRow = Math.max(maxRow, row);
    }
  });

  return {
    width: (maxCol + 1) * runtimeContract.gridSize,
    height: (maxRow + 1) * runtimeContract.gridSize,
  };
}

export function getWorldSizeFromContract(): WorldSize {
  return getRuntimeSceneSizeFromContract() ?? getLayoutCanvasSizeFromExport() ?? getWorldSizeFromMasks();
}

export function getLayoutToWorldScale(): { x: number; y: number } {
  const world = getWorldSizeFromContract();
  const source = getLayoutCanvasSizeFromExport() ?? world;

  return {
    x: world.width / Math.max(1, source.width),
    y: world.height / Math.max(1, source.height),
  };
}

export function getLayoutObjectAnchor(): LayoutAnchor {
  const layout = houseLayout as {
    coordinateSpace?: {
      objectAnchor?: { x?: unknown; y?: unknown };
    };
  };
  const contract = runtimeContract as {
    coordinateSpace?: {
      objectAnchor?: { x?: unknown; y?: unknown };
    };
  };

  const anchor = layout.coordinateSpace?.objectAnchor ?? contract.coordinateSpace?.objectAnchor;
  const x = typeof anchor?.x === 'number' && Number.isFinite(anchor.x) ? clamp(anchor.x, 0, 1) : 0.5;
  const y = typeof anchor?.y === 'number' && Number.isFinite(anchor.y) ? clamp(anchor.y, 0, 1) : 1;
  return { x, y };
}

function projectLayoutPointToWorld(x: number, y: number): { x: number; y: number } {
  const scale = getLayoutToWorldScale();
  return {
    x: x * scale.x,
    y: y * scale.y,
  };
}

function objectToCell(object: LayoutObject, gridSize: number): CellKey {
  const worldPoint = projectLayoutPointToWorld(object.x, object.y);
  const col = Math.max(0, Math.floor(worldPoint.x / gridSize));
  const row = Math.max(0, Math.floor(worldPoint.y / gridSize));
  return toCellKey(col, row);
}

function findObjectByKeywords(keywords: string[]): LayoutObject | null {
  const objects = (houseLayout.objects as LayoutObject[]) || [];

  for (const object of objects) {
    const descriptor = `${object.type} ${object.id}`.toLowerCase();
    if (keywords.some((keyword) => descriptor.includes(keyword))) {
      return object;
    }
  }

  return null;
}

export const runtimeContract = houseRuntimeContract;

export function resolveTaskTargetCells(grid: NavigationGrid): {
  chair: CellKey | null;
  computerDesk: CellKey | null;
  runningMachine: CellKey | null;
  piano: CellKey | null;
  letterDesk: CellKey | null;
  door: CellKey | null;
} {
  const chairObject =
    findObjectByKeywords(['chair']) ||
    findObjectByKeywords(['settee', 'sofa']) ||
    findObjectByKeywords(['bed_']);
  const computerDeskObject = findObjectByKeywords(['computerdesk']);
  const runningMachineObject = findObjectByKeywords(['runningmachine']);
  const pianoObject = findObjectByKeywords(['piano']);
  const deskObject = findObjectByKeywords(['computerdesk', 'desk']);

  const chairCell = chairObject ? findNearestWalkableCell(grid, objectToCell(chairObject, runtimeContract.gridSize)) : null;
  const computerDeskCell = computerDeskObject
    ? findNearestWalkableCell(grid, objectToCell(computerDeskObject, runtimeContract.gridSize))
    : null;
  const runningMachineCell = runningMachineObject
    ? findNearestWalkableCell(grid, objectToCell(runningMachineObject, runtimeContract.gridSize))
    : null;
  const pianoCell = pianoObject
    ? findNearestWalkableCell(grid, objectToCell(pianoObject, runtimeContract.gridSize))
    : null;
  const letterDeskCell = deskObject ? findNearestWalkableCell(grid, objectToCell(deskObject, runtimeContract.gridSize)) : null;

  const doorTrigger = runtimeContract.doorFlow.enabled ? runtimeContract.doorFlow.trigger : null;
  const doorCell = doorTrigger
    ? findNearestWalkableCell(
        grid,
        toCellKey(
          Math.floor((doorTrigger.x + doorTrigger.width * 0.5) / runtimeContract.gridSize),
          Math.floor((doorTrigger.y + doorTrigger.height * 0.5) / runtimeContract.gridSize)
        )
      )
    : null;

  return {
    chair: chairCell,
    computerDesk: computerDeskCell,
    runningMachine: runningMachineCell,
    piano: pianoCell,
    letterDesk: letterDeskCell,
    door: doorCell,
  };
}
