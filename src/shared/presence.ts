// Shape of each participant's Yjs awareness state. Shared by the server, the app shell and the editor.
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** "guest": someone who isn't signed in (a made-up name, no account). */
  kind: "human" | "agent" | "guest";
  avatar?: string;
  /** An agent's session (its session_id), and its title (session_name): its cursor's label is the title ("Agent" without one). */
  session?: string;
  sessionName?: string;
  /** The session's colour (older clients draw a dot in it). */
  sessionColor?: string;
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
