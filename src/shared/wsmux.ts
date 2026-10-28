// Protocol v2: one WebSocket per workspace (docs/07-workspace-socket.md). The framing, the control messages and the
// server's policy constants, shared by the Bun server, the WorkspaceDO and the browser: no Bun, Node or Worker APIs.
//
// A binary frame is `varuint channel · varuint type · payload`; everything after the channel is the v1 frame byte
// for byte. Channel 0 is the socket channel (control JSON only); 1… are note channels, assigned by the server on open.
import type { PresenceUser } from "./presence.ts";

/** The protocol version of this file (`welcome.v`, `/api/server` `ws`). */
export const WS_PROTOCOL = 2;

/** The socket channel: workspace-level control. */
export const SOCKET_CHANNEL = 0;

/** Frame types: the v1 frame's first varuint. */
export const FRAME_SYNC = 0;
export const FRAME_AWARENESS = 1;
export const FRAME_CONTROL = 2;
export type FrameType = typeof FRAME_SYNC | typeof FRAME_AWARENESS | typeof FRAME_CONTROL;

/** Open channels per socket; the next open gets `error 4429`. */
export const MAX_CHANNELS = 8;
/**
 * At most OPEN_RATE_MAX opens per OPEN_RATE_WINDOW_MS per socket; over that, `error 4429`. A reopen of a path whose
 * channel was closed or ended on the same socket within REOPEN_FREE_MS isn't counted (going back to a recent note).
 */
export const OPEN_RATE_MAX = 32;
export const OPEN_RATE_WINDOW_MS = 10_000;
export const REOPEN_FREE_MS = 60_000;
/** Largest frame either side sends or accepts (as v1). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Prefetched (hidden) channels a client opens at once. */
export const MAX_PREFETCH = 2;

/** Awareness renewal on a visible channel when nothing else renewed it (was 15 s in v1). */
export const RENEW_MS = 300_000;
/** The renewal the server asks for (`renew`) while a v1 connection is in the room. */
export const V1_RENEW_MS = 15_000;
/** Remote awareness states owned by a v2 channel expire after this (2.4 × renewal). */
export const AWARENESS_TIMEOUT_MS = 720_000;
/** v1 connections and agents' cursors keep y-protocols' 30 s. */
export const V1_AWARENESS_TIMEOUT_MS = 30_000;
/** The client sends PING this often; the server (or the DO's auto-response) answers PONG. */
export const PING_MS = 30_000;
/** The client reconnects when a pong doesn't come within this. */
export const PONG_TIMEOUT_MS = 10_000;
/** A socket with no ping for this long (2.5 × PING_MS) is dead: the server closes it. */
export const DEAD_SOCKET_MS = 75_000;
/** Client reconnect backoff: doubling from min to max, reset on `welcome`. */
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;

/** The heartbeat text frames (the only text frames in v2). */
export const PING = "ping";
export const PONG = "pong";

/** Socket close codes (§1, §5.3, §7). */
export const CLOSE = {
  /** Not signed in and not a valid guest, or a bad token. */
  unauthorized: 4401,
  /** Cross-origin without a token. */
  forbidden: 4403,
  /** Unknown workspace, or removed. */
  notFound: 4404,
  /** v1 endpoint after its removal: upgrade the app. */
  upgrade: 4426,
  /** Try again (transient admission failure; too slow a reader on Bun). */
  retry: 1013,
  /** Unexpected server error. */
  serverError: 1011,
  /** Service restart (Bun SIGTERM). */
  restart: 1012,
} as const;

/** Codes of `error` (a failed open) and `end` (a channel is over): v1's close codes, as data. */
export const CODE = {
  /** `end` only: after `closed` (deleted, renamed, removed). */
  closed: 4000,
  invalidPath: 4400,
  notFound: 4404,
  tooLarge: 4413,
  /** Too many channels, or too many opens. */
  tooMany: 4429,
  /** Retry (`end`: reopen with `sv`). */
  retry: 1013,
  failed: 1011,
} as const;
export type OpenErrorCode = typeof CODE.invalidPath | typeof CODE.notFound | typeof CODE.tooLarge | typeof CODE.tooMany | typeof CODE.retry | typeof CODE.failed;
export type EndCode = typeof CODE.closed | typeof CODE.notFound | typeof CODE.tooLarge | typeof CODE.retry | typeof CODE.failed;

export type WorkspaceStatus = "ready" | "importing" | "error";

// ---- Socket channel (0) ----

/** ← The first frame after the upgrade. The timings are the server's policy; clients use them, not constants. */
export interface WelcomeMsg {
  t: "welcome";
  v: 2;
  user: PresenceUser;
  /** The whole workspace is read-only. */
  readOnly: boolean;
  status: WorkspaceStatus;
  error?: string;
  maxChannels: number;
  renewMs: number;
  awarenessTimeoutMs: number;
  pingMs: number;
}

/** → Open a note. `sv` is the client's Yjs state vector, base64, when it already has a document for the note. */
export interface OpenMsg {
  t: "open";
  path: string;
  sv?: string;
  readOnly?: boolean;
  /** Open as a prefetch (§3.4). */
  hidden?: boolean;
}

/** ← The channel exists. `req` is the path as sent, `path` the cleaned one. The channel's first frames follow. */
export interface OpenedMsg {
  t: "opened";
  req: string;
  path: string;
  ch: number;
  generation: string;
  readOnly: boolean;
}

/** ← The open failed; no channel exists. */
export interface OpenErrorMsg {
  t: "error";
  req: string;
  path?: string;
  code: OpenErrorCode;
  reason: string;
}

/** → Done with a note. No reply; the client forgets `ch` at once. */
export interface CloseMsg {
  t: "close";
  ch: number;
}

/** → Show or hide a channel (prefetch ↔ visible). */
export interface ViewMsg {
  t: "view";
  ch: number;
  hidden: boolean;
}

/** ← Right after `welcome`: every note with someone in it. */
export interface PresenceSnapshotMsg {
  t: "presence";
  files: Array<{ path: string; users: PresenceUser[] }>;
}

/** ← A note's presence changed (`users: []` = nobody). */
export interface PresenceMsg {
  t: "presence";
  path: string;
  users: PresenceUser[];
}

/** ← The file list or the head changed: refetch the tree (If-None-Match). */
export interface TreeMsg {
  t: "tree";
  head: string;
}

/** ← A note was committed. */
export interface SavedMsg {
  t: "saved";
  path: string;
  sha: string;
}

/** ← The import status (or the title) changed; `removed` is followed by a socket close 4404. */
export interface WorkspaceMsg {
  t: "workspace";
  status: WorkspaceStatus | "removed";
  error?: string;
  title?: string;
}

export type WorkspaceEventMsg = PresenceSnapshotMsg | PresenceMsg | TreeMsg | SavedMsg | WorkspaceMsg;
/** Everything the server sends on channel 0. */
export type ServerSocketMsg = WelcomeMsg | OpenedMsg | OpenErrorMsg | WorkspaceEventMsg;
/** Everything a client sends on channel 0. */
export type ClientSocketMsg = OpenMsg | CloseMsg | ViewMsg;

// ---- Note channels (1…): v1's control messages, plus end and renew ----

export interface NoteStatus {
  dirty: boolean;
  saving: boolean;
  commit: string | null;
  savedAt: number | null;
}

/** ← v1: the channel's first frame. Another generation than the client synced with → throw the document away. */
export interface HelloMsg extends NoteStatus {
  t: "hello";
  generation: string;
  readOnly: boolean;
}

/** ← v1: save status. */
export interface StatusMsg extends NoteStatus {
  t: "status";
}

/** ← v1: the note changed outside (a push) and was merged. */
export interface ExternalMsg {
  t: "external";
  commit: string;
}

/** ← v1: line authors; `lines[i]` indexes `authors`, or -1 (unknown), or ≤ -2 (an origin line). */
export interface BlameMsg {
  t: "blame";
  authors: Array<{ id: string; name: string; kind: PresenceUser["kind"]; color: string }>;
  lines: number[];
}

/** ← v1: the note is gone; `end 4000` follows. */
export interface ClosedMsg {
  t: "closed";
  reason: "deleted" | "renamed" | "removed";
  to?: string;
}

/** ← The channel is over (the v1 socket close, as data). Nothing more comes on it. `1013` = reopen with `sv`. */
export interface EndMsg {
  t: "end";
  code: EndCode;
  reason: string;
}

/** ← Change this channel's awareness renewal interval. */
export interface RenewMsg {
  t: "renew";
  ms: number;
}

/** → v1: commit now. */
export interface FlushMsg {
  t: "flush";
}

export type ServerNoteMsg = HelloMsg | StatusMsg | ExternalMsg | BlameMsg | ClosedMsg | EndMsg | RenewMsg;
export type ClientNoteMsg = FlushMsg;

// ---- varuint (lib0's encoding: 7 bits per byte, low bits first, 0x80 = more) ----

/** Bytes `n` takes as a varuint. */
export function varUintLength(n: number): number {
  let len = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 0x80);
    len++;
  }
  return len;
}

/** Writes `n` (a non-negative safe integer) at `pos`; returns the position after it. */
export function writeVarUint(buf: Uint8Array, pos: number, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a varuint: ${n}`);
  while (n >= 0x80) {
    buf[pos++] = (n % 0x80) | 0x80;
    n = Math.floor(n / 0x80);
  }
  buf[pos++] = n;
  return pos;
}

/** Reads a varuint at `pos`: `[value, next position]`, or null when truncated or over 2^53 − 1. */
export function readVarUint(buf: Uint8Array, pos: number): [number, number] | null {
  let n = 0;
  let mult = 1;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    n += (b & 0x7f) * mult;
    if (n > Number.MAX_SAFE_INTEGER) return null;
    if (b < 0x80) return [n, pos];
    mult *= 0x80;
  }
  return null;
}

// ---- Frames ----

export interface Frame {
  ch: number;
  type: number;
  /** After the type: what the v1 decoders read. */
  payload: Uint8Array;
  /** After the channel: the v1 frame, byte for byte (what `Room.onMessage` and the engines take). */
  body: Uint8Array;
}

/**
 * Splits a binary frame. Null when the channel or the type is missing or malformed. Unknown types are returned
 * (the caller ignores them); `payload` and `body` are views into `data`, not copies.
 */
export function decodeFrame(data: Uint8Array): Frame | null {
  const c = readVarUint(data, 0);
  if (!c) return null;
  const t = readVarUint(data, c[1]);
  if (!t) return null;
  return { ch: c[0], type: t[0], payload: data.subarray(t[1]), body: data.subarray(c[1]) };
}

/** Prefixes a v1 frame (`type · payload`) with its channel: what a channel `Conn.send` puts on the socket. */
export function withChannel(ch: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(varUintLength(ch) + body.length);
  out.set(body, writeVarUint(out, 0, ch));
  return out;
}

/** A whole frame from its parts. */
export function encodeFrame(ch: number, type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(varUintLength(ch) + varUintLength(type) + payload.length);
  out.set(payload, writeVarUint(out, writeVarUint(out, 0, ch), type));
  return out;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** A control frame (type 2, a varString of JSON) on `ch`. */
export function encodeControl(ch: number, msg: object): Uint8Array {
  const json = utf8.encode(JSON.stringify(msg));
  const out = new Uint8Array(varUintLength(ch) + 1 + varUintLength(json.length) + json.length);
  let pos = writeVarUint(out, 0, ch);
  out[pos++] = FRAME_CONTROL;
  out.set(json, writeVarUint(out, pos, json.length));
  return out;
}

/** Any control message: an object with a string `t`. Unknown `t`s and fields are the caller's to ignore. */
export interface ControlMsg {
  t: string;
  [field: string]: unknown;
}

/** The JSON of a control payload (after the type), or null when it isn't a varString of a `{t: string}` object. */
export function decodeControl(payload: Uint8Array): ControlMsg | null {
  const len = readVarUint(payload, 0);
  if (!len || len[1] + len[0] > payload.length) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(utf8Decoder.decode(payload.subarray(len[1], len[1] + len[0])));
  } catch {
    return null;
  }
  return isControl(msg) ? msg : null;
}

function isControl(v: unknown): v is ControlMsg {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { t?: unknown }).t === "string";
}

// ---- Parsing what the other side sent (validates what each side relies on; extra fields are kept) ----

const isChannel = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

/** Server side: a client's channel-0 message, or null (unknown `t` or bad fields: ignore it). */
export function parseClientSocketMsg(m: ControlMsg): ClientSocketMsg | null {
  switch (m.t) {
    case "open":
      if (typeof m.path !== "string" || (m.sv !== undefined && typeof m.sv !== "string") || !optBool(m.readOnly) || !optBool(m.hidden)) return null;
      return m as unknown as OpenMsg;
    case "close":
      return isChannel(m.ch) ? (m as unknown as CloseMsg) : null;
    case "view":
      return isChannel(m.ch) && typeof m.hidden === "boolean" ? (m as unknown as ViewMsg) : null;
  }
  return null;
}

/** Client side: the server's channel-0 message, or null (unknown `t` or bad fields: ignore it). */
export function parseServerSocketMsg(m: ControlMsg): ServerSocketMsg | null {
  switch (m.t) {
    case "welcome":
      return typeof m.v === "number" && typeof m.user === "object" && m.user !== null && typeof m.readOnly === "boolean" && typeof m.status === "string" && isPositive(m.maxChannels) && isPositive(m.renewMs) && isPositive(m.awarenessTimeoutMs) && isPositive(m.pingMs)
        ? (m as unknown as WelcomeMsg)
        : null;
    case "opened":
      return typeof m.req === "string" && typeof m.path === "string" && isChannel(m.ch) && typeof m.generation === "string" && typeof m.readOnly === "boolean" ? (m as unknown as OpenedMsg) : null;
    case "error":
      return typeof m.req === "string" && typeof m.code === "number" && typeof m.reason === "string" ? (m as unknown as OpenErrorMsg) : null;
    case "presence":
      if (Array.isArray(m.files)) return m as unknown as PresenceSnapshotMsg;
      return typeof m.path === "string" && Array.isArray(m.users) ? (m as unknown as PresenceMsg) : null;
    case "tree":
      return typeof m.head === "string" ? (m as unknown as TreeMsg) : null;
    case "saved":
      return typeof m.path === "string" && typeof m.sha === "string" ? (m as unknown as SavedMsg) : null;
    case "workspace":
      return typeof m.status === "string" ? (m as unknown as WorkspaceMsg) : null;
  }
  return null;
}

/** Client side: the v2-only note-channel messages (`end`, `renew`), or null; v1's are handled as in v1. */
export function parseNoteEnd(m: ControlMsg): EndMsg | RenewMsg | null {
  if (m.t === "end") return typeof m.code === "number" && typeof m.reason === "string" ? (m as unknown as EndMsg) : null;
  if (m.t === "renew") return isPositive(m.ms) ? (m as unknown as RenewMsg) : null;
  return null;
}

const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The `welcome` for a socket, with this file's policy. */
export function welcome(user: PresenceUser, readOnly: boolean, status: WorkspaceStatus, error?: string): WelcomeMsg {
  return { t: "welcome", v: WS_PROTOCOL, user, readOnly, status, ...(error ? { error } : {}), maxChannels: MAX_CHANNELS, renewMs: RENEW_MS, awarenessTimeoutMs: AWARENESS_TIMEOUT_MS, pingMs: PING_MS };
}

// ---- State vectors in `open.sv` (base64 of the bytes a sync step 1 carries) ----

export function encodeSv(sv: Uint8Array): string {
  let s = "";
  for (let i = 0; i < sv.length; i += 0x8000) s += String.fromCharCode(...sv.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Null when `sv` isn't base64. */
export function decodeSv(sv: string): Uint8Array | null {
  let s: string;
  try {
    s = atob(sv);
  } catch {
    return null;
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- The client's side, as a shape (CF-43 implements it in src/client/wsclient.ts; CF-44 mirrors it in Rust) ----

/** One open note on a workspace socket, as the editor's collab layer sees it (in place of its own WebSocket). */
export interface WorkspaceChannel {
  readonly path: string;
  /** Null until `opened` (and again while reconnecting). */
  readonly ch: number | null;
  readonly hidden: boolean;
  readonly readOnly: boolean;
  /** Sends a v1 frame (type · payload) on this channel; dropped while it has no channel id. */
  send(body: Uint8Array): void;
  /** Hidden = prefetch: no awareness sent, not in presence. */
  view(hidden: boolean): void;
  close(): void;
}

export interface WorkspaceChannelHandlers {
  /** A v1 frame (type · payload) for this note, after `opened` (and after every reopen). */
  onFrame(body: Uint8Array): void;
  onOpened?(msg: OpenedMsg): void;
  /** `error` or `end`, mapped like v1's close codes. `1013` is handled by the client (it reopens with `sv`). */
  onEnd(code: number, reason: string): void;
  onRenew?(ms: number): void;
  /** The state vector to reopen with after a reconnect or `end 1013`. */
  stateVector?(): Uint8Array | null;
}

/** One socket per workspace per tab or app instance. */
export interface WorkspaceClient {
  readonly workspace: string;
  /** The last `welcome` (null before the first). */
  readonly welcome: WelcomeMsg | null;
  /** Opens a note (idempotent per path; LRU-closes the least recently shown hidden channel past maxChannels). */
  open(path: string, handlers: WorkspaceChannelHandlers, opts?: { hidden?: boolean; readOnly?: boolean }): WorkspaceChannel;
  /** Workspace events (presence, tree, saved, workspace); returns the unsubscribe. */
  onEvent(fn: (msg: WorkspaceEventMsg) => void): () => void;
  close(): void;
}
