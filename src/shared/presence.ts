// Shape of each participant's Yjs awareness state. Shared by the server, the app shell and the editor.
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  kind: "human" | "agent";
  avatar?: string;
}

export interface PresenceCursor {
  // Y.RelativePosition JSON (Y.relativePositionToJSON), so cursors survive concurrent edits.
  anchor: unknown;
  head: unknown;
}

export interface PresenceState {
  user: PresenceUser;
  cursor: PresenceCursor | null;
}
