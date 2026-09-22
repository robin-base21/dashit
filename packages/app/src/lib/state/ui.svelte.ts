import { createContext } from "svelte";
import type { Rect } from "shared";

export type PanelTab = "unplaced" | "hidden";

export type DragKind = "place" | "move" | "resize";

export interface DragSession {
  kind: DragKind;
  elementId: string;
  label: string;
  /** Size of the dragged item in cells. */
  w: number;
  h: number;
  /** Original rect for move/resize; absent for place. */
  origin: Rect | null;
  /** Pointer position at drag start and now, in viewport pixels. */
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Whether the pointer has moved past the drag threshold. */
  started: boolean;
}

export const DEFAULT_SIZE = { w: 4, h: 3 } as const;

/** Cross-route UI state that is not persisted: panel visibility, drag session, dialogs. */
export class UiState {
  elementsPanelOpen = $state(false);
  panelTab = $state<PanelTab>("unplaced");
  createDialogOpen = $state(false);
  drag = $state.raw<DragSession | null>(null);

  openElementsPanel(tab: PanelTab = "unplaced"): void {
    this.panelTab = tab;
    this.elementsPanelOpen = true;
  }

  beginDrag(s: Omit<DragSession, "x" | "y" | "started">): void {
    this.drag = { ...s, x: s.startX, y: s.startY, started: false };
  }

  updateDrag(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const started = d.started || Math.hypot(x - d.startX, y - d.startY) > 4;
    this.drag = { ...d, x, y, started };
  }

  endDrag(): DragSession | null {
    const d = this.drag;
    this.drag = null;
    return d;
  }
}

export const [getUi, setUi] = createContext<UiState>();
