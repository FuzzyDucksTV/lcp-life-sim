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

function objectToCell(object: LayoutObject, gridSize: number): CellKey {
  const col = Math.max(0, Math.floor(object.x / gridSize));
  const row = Math.max(0, Math.floor(object.y / gridSize));
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

export function getWorldSizeFromContract(): { width: number; height: number } {
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
