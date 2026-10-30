// HomeDO: the demo's lobby, `demo-lobby` (DemoLobby, src/server/demo-rooms.ts). It hands out demo rooms, admits every
// REST call and socket on one (the Worker asks it, cached briefly), hears from each room's WorkspaceDO who is
// connected, makes a room's workspace row when it makes the room and deletes it when the room goes. Not per version:
// demo rooms outlive deploys while people are in them.
// (The name is history: this class also used to run the landing page's pencil rooms, before the landing page went
// all client-side. It keeps its name and binding (HOME) so no Durable Object migration is needed.)
import { DurableObject } from "cloudflare:workers";
import { createDemoRoomRow, deleteDemoRoomRow } from "../server/demo.ts";
import { DemoLobby, type Admit } from "../server/demo-rooms.ts";
import { d1Db } from "./db-d1.ts";
import type { Env } from "./index.ts";

/** The demo's lobby (one, whatever the version). */
export const DEMO_LOBBY = "demo-lobby";

export class HomeDO extends DurableObject<Env> {
  private demoState: DemoLobby | null = null;

  private demo(): DemoLobby {
    const db = d1Db(this.env.DB);
    return (this.demoState ??= new DemoLobby({
      onCreate: (id) => createDemoRoomRow(db, id),
      onDrop: (id) => deleteDemoRoomRow(db, id),
    }));
  }

  /** The demo room for `person` (see DemoLobby.assign), or null: try later. */
  demoAssign(person: string, ip: string): Promise<string | null> {
    return this.demo().assign(person, ip);
  }

  /** May `person` use this demo room now? */
  demoAdmit(workspace: string, person: string, ip: string): Admit {
    return this.demo().admit(workspace, person, ip);
  }

  /** A demo room's WorkspaceDO says whose sockets it holds. */
  demoReport(workspace: string, people: string[]): void {
    this.demo().report(workspace, people);
  }

  demoRoomOf(person: string): string | null {
    return this.demo().roomOf(person);
  }

  /** The demo rooms there are (the cron resets each). */
  demoRooms(): string[] {
    return this.demo().list();
  }

  demoStats(): { rooms: number; people: number } {
    return this.demo().stats();
  }
}
