// Inline widgets: the tag syntax (shared/widgets.ts), which tags of a line view are chips (editor-rs/widgets.ts), the
// session chip's labels and the known-sessions source.
import { describe, expect, test } from "bun:test";
import { findWidgets, isWidget } from "../../src/shared/widgets.ts";
import { KnownSessions, knownSessions, lineWidgets, subagentLabel, truncate, widgetAround, withWidgetLabels } from "../../src/client/editor-rs/widgets.ts";
import { visibleText } from "../../src/client/editor-rs/links.ts";
import type { RLine, RSeg } from "../../src/client/editor-rs/lineview.ts";

const names = (s: string) => findWidgets(s).map((w) => [w.name, w.attrs, s.slice(w.from, w.to)]);

describe("widget syntax", () => {
  test("a session tag anywhere in a line, double or single quotes", () => {
    expect(names('With <session id="ses_1" /> here')).toEqual([["session", { id: "ses_1" }, '<session id="ses_1" />']]);
    expect(names("<session id='ses_2'/>")).toEqual([["session", { id: "ses_2" }, "<session id='ses_2'/>"]]);
    expect(names('<session id="a" x="1" /> and <session id="b" />').map((n) => n[1])).toEqual([{ id: "a", x: "1" }, { id: "b" }]);
  });
  test("unknown names, a missing or empty id, broken syntax and escaped tags stay literal", () => {
    expect(findWidgets("<foo />")).toEqual([]);
    expect(findWidgets('<foo id="x" />')).toEqual([]);
    expect(findWidgets("<session />")).toEqual([]);
    expect(findWidgets('<session id="" />')).toEqual([]);
    expect(findWidgets('<session id="x">')).toEqual([]);
    expect(findWidgets('<session id="x />')).toEqual([]);
    expect(findWidgets('<session id = "x" />')).toEqual([]);
    expect(findWidgets('<sessionid="x" />')).toEqual([]);
    expect(findWidgets('\\<session id="x" />')).toEqual([]);
    expect(findWidgets('<Session id="x" />')).toEqual([]);
  });
  test("the first of a repeated attribute wins; isWidget", () => {
    expect(findWidgets('<session id="a" id="b" />')[0]!.attrs.id).toBe("a");
    expect(isWidget("session", { id: "x" })).toBe(true);
    expect(isWidget("session", { id: " " })).toBe(false);
    expect(isWidget("toString", { id: "x" })).toBe(false);
  });
});

const seg = (kind: RSeg["kind"], from: number, to: number, cls: string[] = [], hidden = false): RSeg => ({ kind, from, to, cls, hidden });
const line = (segs: RSeg[], extra: Partial<RLine> = {}): RLine =>
  ({ key: "k", len: 0, textFrom: 0, type: "paragraph", level: 0, checked: false, indent: 0, gutterLevels: 0, active: false, revealed: false, collapsed: false, code: null, table: null, segs, images: [], imageOnly: false, parts: [], foldable: false, folded: false, hidden: false, sig: "", ...extra }) as RLine;

describe("widgets of a line view", () => {
  const text = 'a <session id="x" /> b';
  test("in plain text: a chip", () => {
    expect(lineWidgets(line([seg("text", 0, text.length)]), text).map((w) => [w.from, w.to])).toEqual([[2, 20]]);
  });
  test("in inline code, a marker inside, a code line: literal", () => {
    const code = '`<session id="x" />`';
    expect(lineWidgets(line([seg("mk", 0, 1, ["code"]), seg("text", 1, code.length - 1, ["code"]), seg("mk", code.length - 1, code.length, ["code"])]), code)).toEqual([]);
    expect(lineWidgets(line([seg("text", 0, 5), seg("mk", 5, 7), seg("text", 7, text.length)]), text)).toEqual([]);
    expect(lineWidgets(line([seg("text", 0, text.length)], { type: "code", code: { first: false, last: false } }), text)).toEqual([]);
  });
  test("split over styled text segments (a bold run around it) is still a chip", () => {
    expect(lineWidgets(line([seg("text", 0, 2), seg("text", 2, 20, ["b"]), seg("text", 20, text.length)]), text)).toHaveLength(1);
  });
  test("widgetAround: strictly inside", () => {
    const ws = findWidgets(text);
    expect(widgetAround(ws, 2)).toBeUndefined();
    expect(widgetAround(ws, 3)?.from).toBe(2);
    expect(widgetAround(ws, 20)).toBeUndefined();
  });
});

describe("session chip", () => {
  test("labels", () => {
    expect(subagentLabel(0)).toBe("");
    expect(subagentLabel(undefined)).toBe("");
    expect(subagentLabel(1)).toBe("1 subagent");
    expect(subagentLabel(3)).toBe("3 subagents");
    expect(truncate("short")).toBe("short");
    expect(truncate("x".repeat(60))).toBe("x".repeat(47) + "…");
  });
  test("known sessions learn titles from presence users and line authors", () => {
    const k = new KnownSessions();
    const seen: (string | null)[] = [];
    k.subscribe((id) => seen.push(id));
    k.learnUsers([{ kind: "agent", session: "ses_a", sessionName: " Fix it " }, { kind: "human", name: "Ann" }, null]);
    expect(k.get("ses_a")).toEqual({ id: "ses_a", title: "Fix it" });
    k.learnUsers([{ session: "ses_a", sessionName: "Fix it" }]);
    expect(seen).toEqual(["ses_a"]);
    expect(k.get("ses_b")).toBeUndefined();
  });
});

describe("widgets as text", () => {
  test("withWidgetLabels: a session's title or id, not in inline code", () => {
    knownSessions.learn("ses_t", "Trip plans");
    expect(withWidgetLabels('# <session id="ses_t" />')).toBe("# Trip plans");
    expect(withWidgetLabels("# Work: <session id='ses_unknown' />")).toBe("# Work: ses_unknown");
    expect(withWidgetLabels('# `<session id="ses_t" />` and <foo />')).toBe('# `<session id="ses_t" />` and <foo />');
  });
  test("visibleText of a heading line view: the widget as its label", () => {
    const text = '## Work: <session id="ses_unknown2" />';
    const l = line([seg("token", 0, 3), seg("text", 3, text.length)], { type: "heading", level: 2 });
    expect(visibleText(l, text, lineWidgets(l, text))).toBe("Work: ses_unknown2");
    expect(visibleText(l, text)).toBe('Work: <session id="ses_unknown2" />');
  });
});
