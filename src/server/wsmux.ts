// The server side of protocol v2 (docs/07-workspace-socket.md, "Implementation shape"): one WorkspaceSocket per
// socket, shared by Bun (WorkspaceRuntime) and the WorkspaceDO, with small host hooks. Declared here; CF-41
// implements it (Bun), CF-42 hosts it in the DO. The framing and the messages are in ../shared/wsmux.ts.
import type { Conn, Participant, Room } from "./room.ts";
import type { WsReject } from "./seams/workspace-host.ts";
import type { OpenErrorCode, WorkspaceEventMsg, WorkspaceStatus } from "../shared/wsmux.ts";

export * from "../shared/wsmux.ts";

/** Channel flags in the attachment (§5.1). */
export const CH_READ_ONLY = 1;
export const CH_HIDDEN = 2;

/** The admission of a v2 socket (`X-Grim-Admission` v2 on Workers): the workspace, no path. */
export interface AdmittedSocket {
  v: 2;
  repoId: string;
  branch: string;
  status: WorkspaceStatus;
  error?: string;
  participant: Participant;
  /** The whole workspace is read-only. */
  readOnly: boolean;
}

/** One open channel. */
export interface ChannelInfo {
  ch: number;
  /** Cleaned path. */
  path: string;
  generation: string;
  readOnly: boolean;
  hidden: boolean;
}

/**
 * The multiplexer's state, enough to rebuild it without the rooms: the DO's hibernation attachment (§5.1) is this,
 * serialized and fitted by the host. Awareness states are the visible channels' only.
 */
export interface MuxState {
  v: 2;
  u: Participant;
  b: string;
  ro: boolean;
  /** Next channel id (never reused on a socket). */
  n: number;
  c: Array<[ch: number, path: string, generation: string, flags: number]>;
  aw: Array<[ch: number, clientId: number, clock: number, state: string]>;
}

/** A note channel as the room sees it: `send` adds the channel prefix, `close(code, reason)` sends `end`. */
export interface ChannelConn extends Conn {
  readonly ch: number;
  /** Hidden channels aren't presence (Room.participants skips them unless they have an awareness state). */
  hidden: boolean;
  /** Owned awareness states expire after this (AWARENESS_TIMEOUT_MS for v2; v1 conns keep 30 s). */
  readonly awarenessTimeoutMs: number;
}

/** What opening a note's room gave: the room, or an `error` for the open. */
export type OpenRoomResult = { room: Room } | { reject: WsReject & { code: OpenErrorCode } };

/** What a WorkspaceSocket needs from where it runs. */
export interface MuxHost {
  /**
   * Open (or wake) the room of a cleaned path: admitFile's logic (4404, 4413, 1013 incl. a workspace that isn't
   * ready, 1011). Opens run in parallel.
   */
  openRoom(path: string): Promise<OpenRoomResult>;
  /** Puts a frame on the socket (binary, or the "pong" text on Bun). */
  send(data: Uint8Array | string): void;
  /** Closes the whole socket (4404 removed, 1013 too slow, 1012 restart). */
  closeSocket(code: number, reason?: string): void;
  /** The state changed (open, close, view, an awareness update): no-op on Bun; serializeAttachment + fit in the DO. */
  persist(state: MuxState): void;
  /** Channel open/close/view changed this socket's presence: the workspace recomputes and fans it out. */
  presenceChanged(paths: string[]): void;
}

/** One v2 socket. */
export interface WorkspaceSocket {
  readonly user: Participant;
  readonly readOnly: boolean;
  readonly channels: ReadonlyMap<number, ChannelInfo>;
  /** Sends `welcome` and the presence snapshot (the first frames after the upgrade). */
  start(status: WorkspaceStatus, error: string | undefined, presence: WorkspaceEventMsg): void;
  /** A frame from the client: channel-0 control (open/close/view), a note channel's v1 frame, or "ping". */
  onMessage(data: Uint8Array | string): void;
  /** A workspace event on channel 0. */
  sendEvent(msg: WorkspaceEventMsg): void;
  /** Ends one channel (`end code reason`), leaving its room; the socket stays. */
  end(ch: number, code: number, reason: string): void;
  /** The socket is gone: every channel leaves its room (presence and awareness go at once). */
  closed(): void;
  /** The state to persist (also what `persist` gets). */
  state(): MuxState;
}

/** Makes a socket: fresh from an admission, or (the DO after a wake) from a persisted state, with no room wakes. */
export type CreateWorkspaceSocket = (host: MuxHost, from: { admission: AdmittedSocket } | { restore: MuxState }) => WorkspaceSocket;

/** The sockets of one workspace (WorkspaceRuntime on Bun, the WorkspaceDO): events and presence from the channel table. */
export interface WorkspaceSockets {
  add(sock: WorkspaceSocket): void;
  remove(sock: WorkspaceSocket): void;
  /** To every socket of the workspace. */
  broadcast(msg: WorkspaceEventMsg): void;
  /** Every note with someone in it: visible channels plus agents' cursors in rooms in memory. */
  presenceSnapshot(): WorkspaceEventMsg;
  /** The socket channels on a path (the DO's wake index; Room.reattach puts them all back). */
  channelsOn(path: string): Array<[WorkspaceSocket, ChannelInfo]>;
}
