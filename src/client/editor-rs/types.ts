// The Rust engine's boundary (docs/rust-engine/PLAN.md, contracts 3 and 4). All offsets are UTF-16 code units
// into the Markdown text; geometry is in editor content coordinates (CSS px from the top-left of the editor
// root's border box, scroll included).

export type Edit = { from: number; to: number; insert: string };

export interface PatchLines {
  start: number;
  deleteCount: number;
  insert: LineViewJs[];
}

export interface Patch {
  lines?: PatchLines | null;
  sel: { anchor: number; head: number };
  edits?: Edit[] | null;
  scroll?: "caret" | "start" | "end" | null;
  composing?: boolean | null;
}

export interface CutResult {
  text: string;
  patch: Patch;
}

/** editor-core SegView. Enum values may come in any case ("Marker", "marker"); see lineview.ts. */
export interface SegViewJs {
  kind: string;
  from: number;
  to: number;
  styles: string[];
  hidden: boolean;
  token?: string | null;
  cell?: number | null;
  el?: number | null;
}

export interface ImageViewJs {
  from: number;
  to: number;
  altRange: [number, number];
  alt: string;
  src: string;
  title?: string | null;
  revealed: boolean;
}

export interface LineViewJs {
  /** Stable identity for DOM reuse. */
  key: string;
  /** Length of the line's text (without the newline). All other offsets are relative to the line start. */
  len: number;
  textFrom: number;
  kind: string;
  level: number;
  checked: boolean;
  number: number;
  indent: number;
  gutterLevels: number;
  active: boolean;
  revealed: boolean;
  collapsed: boolean;
  code?: { first: boolean; last: boolean } | null;
  table?: { align: (string | null)[]; cells: number; columns: number } | null;
  segments: SegViewJs[];
  images: ImageViewJs[];
  imageOnly: boolean;
  /** The line's raw text. */
  text: string;
}

export interface JsLayout {
  caret_rect(pos: number): [x: number, y: number, w: number, h: number];
  hit_test(x: number, y: number): number | undefined;
  bounds(): [w: number, h: number];
  /** The adjacent visual line's middle y; null: there is none (document edge); undefined: unknown (the engine probes). */
  adjacent_line_y(pos: number, dir: -1 | 1): number | null | undefined;
  table_cell_at(line: number, x: number, y: number): number | undefined;
  line_mid_y(line: number): number | undefined;
  image_at(x: number, y: number): [from: number, to: number] | undefined;
}

/** mods bitmask */
export const SHIFT = 1;
export const ALT = 2;
export const CTRL = 4;
export const META = 8;

export interface Engine {
  text(): string;
  render_all(): Patch;
  insert_text(s: string): Patch;
  key(key: string, mods: number, layout: JsLayout): Patch | undefined;
  mouse_down(x: number, y: number, clicks: number, shift: boolean, layout: JsLayout): Patch;
  mouse_drag(x: number, y: number, layout: JsLayout): Patch;
  set_selection(anchor: number, head: number): Patch;
  begin_composition(): void;
  /** Ends a composition: after a commit (`insert_text`) nothing changes; cancelled, the selection it replaced goes. */
  end_composition(): Patch;
  paste(text: string): Patch;
  cut(): CutResult;
  copy(): string;
  /** One edit replacing [from, to) (spelling corrections), without typing rules. */
  replace_range(from: number, to: number, text: string): Patch;
  undo(): Patch;
  redo(): Patch;
  toggle_todo(line: number): Patch;
  set_read_only(ro: boolean): void;
  apply_remote(edits: Edit[]): Patch;
  free?(): void;
}

export type EngineFactory = (text: string) => Engine;

// Collab engines (`Engine.collab(clientId, user)`, contract 4 "collab"): the engine owns the shared document.

export interface SaveStateJs {
  dirty: boolean;
  saving: boolean;
  commit: string | null;
  savedAt: number | null;
}

export type Notice =
  | { t: "hello"; readOnly: boolean; saveState: SaveStateJs }
  | { t: "synced" }
  | { t: "readOnly"; readOnly: boolean }
  | { t: "saveState"; saveState: SaveStateJs }
  | { t: "external"; commit: string | null }
  | { t: "reset" };

export interface Received {
  /** Remote edits (`edits` = the change) or, with `reloaded`, a full render. */
  patch?: Patch | null;
  frames: Uint8Array[];
  notices: Notice[];
  awareness: boolean;
  reloaded: boolean;
  error?: string | null;
}

export interface Outgoing {
  frames: Uint8Array[];
  wakeInMs?: number | null;
  awareness: boolean;
}

export type AfterClose = { retry: number } | { closed: string; to: string | null };

export interface PeerCursor {
  client: number;
  userId: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
  /** The cursor as published: changes only when that participant moves it. */
  key: string;
}

export interface CollabEngine extends Engine {
  receive(frame: Uint8Array): Received;
  take_outgoing(nowMs: number): Outgoing;
  set_focused(focused: boolean, nowMs: number): Uint8Array[];
  connecting(): void;
  disconnected(code: number, reason: string): AfterClose;
  online(): boolean;
  reset(clientId: number): Patch;
  request_flush(): Uint8Array[];
  leave(): Uint8Array[];
  status(): string;
  synced(): boolean;
  read_only(): boolean;
  save_state(): SaveStateJs | null;
  client_id(): number;
  remote_cursors(): PeerCursor[];
  peers(): { client: number; state: unknown }[];
  is_consistent(): boolean;
}
