// Undo/redo on top of Y.UndoManager. Only transactions with our local origin are tracked, so remote
// edits are never undone. Grouping is driven explicitly with stop() (no time-based breaks).
// Each stack item stores two selections in its meta: "sel" (restored when the item is popped) and
// "after" (the selection on the other side of the change, handed to the inverse item).
//
// Besides Yjs stack items, the history holds "marks": local-only undo steps that change no text
// (an auto-conversion shown literally again). A mark sits at a given depth of the undo/redo stack.

import * as Y from "yjs";

export interface RelSel {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
  /** Absolute fallback when the relative positions can't be resolved. */
  abs: { anchor: number; head: number };
}

interface Mark<T> {
  depth: number;
  data: T;
}

export class History<M = unknown> {
  readonly um: Y.UndoManager;
  /** Selection captured right before the next tracked transaction. */
  selBefore: RelSel | null = null;
  /** Kind of the next tracked edit (stored in the stack item's meta). */
  kind = "input";
  private afterNext: RelSel | null = null;
  private popping = false;
  private undoMarks: Mark<M>[] = [];
  private redoMarks: Mark<M>[] = [];

  constructor(
    ytext: Y.Text,
    origin: object,
    private current: () => RelSel,
    onRestore: (sel: RelSel | undefined, type: "undo" | "redo", kind: string) => void,
    private onMark: (data: M, type: "undo" | "redo") => void,
    private markValid: (data: M, type: "undo" | "redo") => boolean,
  ) {
    this.um = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([origin]),
      captureTimeout: Number.MAX_SAFE_INTEGER,
    });
    this.um.on("stack-item-added", ({ stackItem }) => {
      if (!this.popping) this.redoMarks = [];
      const meta = stackItem.meta;
      if (!meta.has("sel") && this.selBefore) meta.set("sel", this.selBefore);
      meta.set("after", this.afterNext ?? this.current());
      if (!meta.has("kind")) meta.set("kind", this.kind);
    });
    this.um.on("stack-item-updated", ({ stackItem, type }) => {
      if (!this.popping) this.redoMarks = [];
      if (type === "undo") stackItem.meta.set("after", this.current());
    });
    this.um.on("stack-item-popped", ({ stackItem, type }) => {
      const meta = stackItem.meta;
      onRestore(meta.get("sel") as RelSel | undefined, type, (meta.get("kind") as string) ?? "input");
    });
  }

  /** End the current undo group. */
  stop(): void {
    this.um.stopCapturing();
  }

  /** Push a local-only undo step on top of the undo stack. */
  pushMark(data: M): void {
    this.um.stopCapturing();
    this.undoMarks.push({ depth: this.um.undoStack.length, data });
    this.redoMarks = [];
  }

  private pop(stack: Y.UndoManager["undoStack"], run: () => unknown, current: RelSel): boolean {
    const top = stack[stack.length - 1];
    if (!top) return false;
    this.selBefore = (top.meta.get("after") as RelSel | undefined) ?? current;
    this.afterNext = (top.meta.get("sel") as RelSel | undefined) ?? null;
    this.kind = (top.meta.get("kind") as string) ?? "input";
    this.um.stopCapturing();
    this.popping = true;
    try {
      run();
    } finally {
      this.popping = false;
      this.afterNext = null;
      this.um.stopCapturing();
    }
    return true;
  }

  undo(current: RelSel): boolean {
    this.undoMarks = this.undoMarks.filter((m) => m.depth <= this.um.undoStack.length);
    let m = this.undoMarks[this.undoMarks.length - 1];
    // a mark whose line changed meanwhile (e.g. a remote edit) is dropped, not a dead undo step
    while (m && m.depth === this.um.undoStack.length && !this.markValid(m.data, "undo")) {
      this.undoMarks.pop();
      m = this.undoMarks[this.undoMarks.length - 1];
    }
    if (m && m.depth === this.um.undoStack.length) {
      this.undoMarks.pop();
      this.redoMarks.push({ depth: this.um.redoStack.length, data: m.data });
      this.um.stopCapturing();
      this.onMark(m.data, "undo");
      return true;
    }
    return this.pop(this.um.undoStack, () => this.um.undo(), current);
  }

  redo(current: RelSel): boolean {
    this.redoMarks = this.redoMarks.filter((m) => m.depth <= this.um.redoStack.length);
    let m = this.redoMarks[this.redoMarks.length - 1];
    while (m && m.depth === this.um.redoStack.length && !this.markValid(m.data, "redo")) {
      this.redoMarks.pop();
      m = this.redoMarks[this.redoMarks.length - 1];
    }
    if (m && m.depth === this.um.redoStack.length) {
      this.redoMarks.pop();
      this.undoMarks.push({ depth: this.um.undoStack.length, data: m.data });
      this.um.stopCapturing();
      this.onMark(m.data, "redo");
      return true;
    }
    return this.pop(this.um.redoStack, () => this.um.redo(), current);
  }

  destroy(): void {
    this.um.destroy();
  }
}
