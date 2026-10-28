// Shape of each participant's Yjs awareness state. Shared by the server, the app shell and the editor.
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** "guest": someone who isn't signed in (a made-up name, no account). */
  kind: "human" | "agent" | "guest";
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
