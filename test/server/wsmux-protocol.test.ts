import { describe, expect, test } from "bun:test";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import {
  CODE,
  decodeControl,
  decodeFrame,
  decodeSv,
  encodeControl,
  encodeFrame,
  encodeSv,
  FRAME_AWARENESS,
  FRAME_CONTROL,
  FRAME_SYNC,
  MAX_CHANNELS,
  parseClientSocketMsg,
  parseNoteEnd,
  parseServerSocketMsg,
  readVarUint,
  SOCKET_CHANNEL,
  varUintLength,
  welcome,
  withChannel,
  writeVarUint,
  type ControlMsg,
} from "../../src/shared/wsmux.ts";

const EDGES = [0, 1, 127, 128, 255, 16383, 16384, 2 ** 21 - 1, 2 ** 21, 2 ** 31 - 1, 2 ** 32, 2 ** 49, Number.MAX_SAFE_INTEGER];

function lib0VarUint(n: number) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, n);
  return encoding.toUint8Array(enc);
}

function v1Control(msg: object) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, FRAME_CONTROL);
  encoding.writeVarString(enc, JSON.stringify(msg));
  return encoding.toUint8Array(enc);
}

const ctl = (m: object) => m as ControlMsg;

describe("varuint", () => {
  test("byte-identical to lib0 at the edges, and round-trips", () => {
    for (const n of EDGES) {
      const ours = new Uint8Array(varUintLength(n));
      expect(writeVarUint(ours, 0, n)).toBe(ours.length);
      expect(ours).toEqual(lib0VarUint(n));
      expect(readVarUint(ours, 0)).toEqual([n, ours.length]);
      expect(decoding.readVarUint(decoding.createDecoder(ours))).toBe(n);
    }
  });

  test("channels 1–127 take one byte", () => {
    expect(varUintLength(1)).toBe(1);
    expect(varUintLength(127)).toBe(1);
    expect(varUintLength(128)).toBe(2);
  });

  test("reads at an offset", () => {
    expect(readVarUint(new Uint8Array([9, 0x80, 0x01, 7]), 1)).toEqual([128, 3]);
  });

  test("truncated, empty or over 2^53 − 1 is null", () => {
    expect(readVarUint(new Uint8Array([]), 0)).toBeNull();
    expect(readVarUint(new Uint8Array([0x80]), 0)).toBeNull();
    expect(readVarUint(new Uint8Array([0xff, 0xff]), 0)).toBeNull();
    expect(readVarUint(new Uint8Array(9).fill(0xff), 0)).toBeNull();
    expect(readVarUint(new Uint8Array([...new Uint8Array(8).fill(0xff), 0x01]), 0)).toBeNull();
  });

  test("refuses to write what isn't a non-negative safe integer", () => {
    const buf = new Uint8Array(16);
    for (const n of [-1, 1.5, NaN, Infinity, 2 ** 53]) expect(() => writeVarUint(buf, 0, n)).toThrow(RangeError);
  });
});

describe("frames", () => {
  test("the body after the channel is the v1 frame, byte for byte", () => {
    const doc = new Y.Doc();
    doc.getText("md").insert(0, "hello");
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, FRAME_SYNC);
    encoding.writeVarUint(enc, 2);
    encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(doc));
    const v1 = encoding.toUint8Array(enc);
    for (const ch of [1, 127, 128, 70000]) {
      const framed = withChannel(ch, v1);
      expect(framed.length).toBe(v1.length + varUintLength(ch));
      const f = decodeFrame(framed)!;
      expect(f.ch).toBe(ch);
      expect(f.type).toBe(FRAME_SYNC);
      expect(f.body).toEqual(v1);
      expect(f.payload).toEqual(v1.subarray(1));
    }
  });

  test("encodeFrame = withChannel of type · payload", () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(encodeFrame(5, FRAME_AWARENESS, payload)).toEqual(withChannel(5, new Uint8Array([FRAME_AWARENESS, 1, 2, 3])));
    expect(decodeFrame(encodeFrame(300, 999, payload))).toMatchObject({ ch: 300, type: 999, payload });
  });

  test("an empty payload is a frame; a missing type or channel is not", () => {
    expect(decodeFrame(new Uint8Array([3, 1]))).toMatchObject({ ch: 3, type: 1, payload: new Uint8Array() });
    expect(decodeFrame(new Uint8Array([]))).toBeNull();
    expect(decodeFrame(new Uint8Array([3]))).toBeNull();
    expect(decodeFrame(new Uint8Array([0x80]))).toBeNull();
    expect(decodeFrame(new Uint8Array([1, 0x80]))).toBeNull();
  });

  test("payload and body are views, not copies", () => {
    const data = encodeFrame(2, FRAME_SYNC, new Uint8Array([7, 8]));
    const f = decodeFrame(data)!;
    expect(f.payload.buffer).toBe(data.buffer);
    expect(f.body.byteOffset).toBe(1);
  });
});

describe("control", () => {
  test("encodeControl is the channel plus the v1 control frame lib0 writes", () => {
    const msg = { t: "hello", generation: "g1", path: "ünïcödé/✓.md" };
    expect(encodeControl(4, msg)).toEqual(withChannel(4, v1Control(msg)));
    const f = decodeFrame(encodeControl(SOCKET_CHANNEL, msg))!;
    expect(f.ch).toBe(0);
    expect(f.type).toBe(FRAME_CONTROL);
    expect(decodeControl(f.payload)).toEqual(msg);
  });

  test("long messages (multi-byte length) round-trip", () => {
    const msg = { t: "open", path: "x".repeat(20000) };
    expect(decodeControl(decodeFrame(encodeControl(0, msg))!.payload)).toEqual(msg);
  });

  test("malformed payloads are null", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    const varStr = (b: Uint8Array) => new Uint8Array([b.length, ...b]);
    expect(decodeControl(new Uint8Array([]))).toBeNull();
    expect(decodeControl(new Uint8Array([10, 0x7b]))).toBeNull(); // length past the end
    expect(decodeControl(varStr(bytes("{nope")))).toBeNull();
    expect(decodeControl(varStr(bytes("[1]")))).toBeNull();
    expect(decodeControl(varStr(bytes("null")))).toBeNull();
    expect(decodeControl(varStr(bytes('"s"')))).toBeNull();
    expect(decodeControl(varStr(bytes('{"t":1}')))).toBeNull();
    expect(decodeControl(varStr(bytes("{}")))).toBeNull();
    expect(decodeControl(new Uint8Array([2, 0xc3, 0x28]))).toBeNull(); // invalid UTF-8
    expect(decodeControl(varStr(bytes('{"t":"x","extra":[1]}')))).toEqual({ t: "x", extra: [1] });
  });
});

describe("parsing", () => {
  test("client socket messages", () => {
    expect(parseClientSocketMsg(ctl({ t: "open", path: "a.md" }))).toEqual({ t: "open", path: "a.md" });
    expect(parseClientSocketMsg(ctl({ t: "open", path: "a.md", sv: "AAE=", readOnly: true, hidden: false, x: 1 }))).not.toBeNull();
    expect(parseClientSocketMsg(ctl({ t: "open" }))).toBeNull();
    expect(parseClientSocketMsg(ctl({ t: "open", path: "a.md", sv: 3 }))).toBeNull();
    expect(parseClientSocketMsg(ctl({ t: "open", path: "a.md", hidden: "yes" }))).toBeNull();
    expect(parseClientSocketMsg(ctl({ t: "close", ch: 3 }))).toEqual({ t: "close", ch: 3 });
    for (const ch of [0, -1, 1.5, "3", undefined]) expect(parseClientSocketMsg(ctl({ t: "close", ch }))).toBeNull();
    expect(parseClientSocketMsg(ctl({ t: "view", ch: 2, hidden: true }))).toEqual({ t: "view", ch: 2, hidden: true });
    expect(parseClientSocketMsg(ctl({ t: "view", ch: 2 }))).toBeNull();
    expect(parseClientSocketMsg(ctl({ t: "nope" }))).toBeNull();
  });

  test("server socket messages", () => {
    const user = { id: "u1", name: "A", color: "#f00", kind: "human" as const };
    const w = welcome(user, false, "importing");
    expect(w).toEqual({ t: "welcome", v: 2, user, readOnly: false, status: "importing", maxChannels: MAX_CHANNELS, renewMs: 300000, awarenessTimeoutMs: 720000, pingMs: 30000 });
    expect(welcome(user, true, "error", "boom").error).toBe("boom");
    const roundTrip = (m: object) => parseServerSocketMsg(decodeControl(decodeFrame(encodeControl(0, m))!.payload)!);
    expect(roundTrip(w)).toEqual(w);
    expect(roundTrip({ ...w, pingMs: 0 })).toBeNull();
    const opened = { t: "opened" as const, req: "/a.md", path: "a.md", ch: 1, generation: "g", readOnly: false };
    expect(roundTrip(opened)).toEqual(opened);
    expect(roundTrip({ ...opened, ch: 0 })).toBeNull();
    expect(roundTrip({ t: "error", req: "x", code: CODE.tooMany, reason: "too many channels" })).not.toBeNull();
    expect(roundTrip({ t: "error", req: "x" })).toBeNull();
    expect(roundTrip({ t: "presence", files: [{ path: "a.md", users: [user] }] })).toEqual({ t: "presence", files: [{ path: "a.md", users: [user] }] });
    expect(roundTrip({ t: "presence", path: "a.md", users: [] })).toEqual({ t: "presence", path: "a.md", users: [] });
    expect(roundTrip({ t: "presence", path: "a.md" })).toBeNull();
    expect(roundTrip({ t: "tree", head: "abc" })).toEqual({ t: "tree", head: "abc" });
    expect(roundTrip({ t: "saved", path: "a.md", sha: "abc" })).not.toBeNull();
    expect(roundTrip({ t: "saved", path: "a.md" })).toBeNull();
    expect(roundTrip({ t: "workspace", status: "removed" })).toEqual({ t: "workspace", status: "removed" });
    expect(roundTrip({ t: "future", x: 1 })).toBeNull();
  });

  test("note channel end and renew", () => {
    expect(parseNoteEnd(ctl({ t: "end", code: 1013, reason: "reset" }))).toEqual({ t: "end", code: 1013, reason: "reset" });
    expect(parseNoteEnd(ctl({ t: "end", code: 1013 }))).toBeNull();
    expect(parseNoteEnd(ctl({ t: "renew", ms: 15000 }))).toEqual({ t: "renew", ms: 15000 });
    expect(parseNoteEnd(ctl({ t: "renew", ms: 0 }))).toBeNull();
    expect(parseNoteEnd(ctl({ t: "hello" }))).toBeNull();
  });
});

describe("state vectors", () => {
  test("round-trip, including large ones", () => {
    const doc = new Y.Doc();
    doc.getText("md").insert(0, "x");
    const sv = Y.encodeStateVector(doc);
    expect(decodeSv(encodeSv(sv))).toEqual(sv);
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(decodeSv(encodeSv(big))).toEqual(big);
    expect(decodeSv(encodeSv(new Uint8Array()))).toEqual(new Uint8Array());
  });

  test("not base64 is null", () => {
    expect(decodeSv("@@@")).toBeNull();
  });
});
