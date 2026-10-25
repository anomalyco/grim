// Compare Bear and our editor step by step. Usage: bun tools/parity/compare.ts bear.json ours.json [report.md]
interface StepState {
  step: string;
  line: string;
  lineNo: number;
}
interface Result {
  id: string;
  target: string;
  states: StepState[];
  raw: string;
}

const [bearPath, oursPath, outPath = "/tmp/opencode/parity-report.md"] = process.argv.slice(2);
if (!bearPath || !oursPath) {
  console.error("usage: bun tools/parity/compare.ts bear.json ours.json [report.md]");
  process.exit(1);
}
const load = async (p: string) => ((await Bun.file(p).json()) as Result[]).filter((r) => r.target === (p === bearPath ? "bear" : "ours"));
const bear = new Map((await load(bearPath)).map((r) => [r.id, r]));
const ours = new Map((await load(oursPath)).map((r) => [r.id, r]));

/**
 * Remove readout differences that aren't interaction differences: Bear doesn't expose highlight/code styling or
 * highlight marker color through accessibility, and shows a tag pill at line start as attachment characters.
 */
function normalize(line: string): string {
  return line
    .replace(/⟨([A-Z]+):/g, (_, f: string) => `⟨${f.replace(/[HC]/g, "")}:`)
    .replace(/⟨:([^⟩]*)⟩/g, "$1")
    .replace(/‹=›/g, "=")
    .replace(/^▸▸#/, "#");
}

const esc = (s: string) => "`" + s.replace(/`/g, "ˋ").replace(/\n/g, "⏎").replace(/\t/g, "⇥") + "`";
let pass = 0;
let fail = 0;
const lines: string[] = [];
const failures: string[] = [];
for (const [id, b] of bear) {
  const o = ours.get(id);
  if (!o) continue;
  const rows: string[] = [];
  let ok = b.raw === o.raw;
  for (let i = 0; i < Math.max(b.states.length, o.states.length); i++) {
    const bs = b.states[i];
    const os = o.states[i];
    const same = bs && os && normalize(bs.line) === normalize(os.line) && bs.lineNo === os.lineNo;
    if (!same) ok = false;
    rows.push(`| ${same ? "" : "❌"} | ${esc(bs?.step ?? os?.step ?? "")} | ${bs ? `L${bs.lineNo} ${esc(bs.line)}` : "—"} | ${os ? `L${os.lineNo} ${esc(os.line)}` : "—"} |`);
  }
  rows.push(`| ${b.raw === o.raw ? "" : "❌"} | **raw** | ${esc(b.raw)} | ${esc(o.raw)} |`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(id);
  }
  lines.push(`### ${ok ? "✅" : "❌"} ${id}`, "", "| | step | Bear | ours |", "|---|---|---|---|", ...rows, "");
}
const header = [
  "# Editor parity report",
  "",
  `${pass} match, ${fail} differ.`,
  "",
  "View format: hidden characters are omitted, `▸` = block token (bullet/heading/quote...), `✎` = link chip, `‹x›` = visible syntax marker, `⟨B:text⟩` = styled run (B bold, I italic, S strike, U underline, H highlight, C code), `|` = caret, `[…]` = selection.",
  "",
  failures.length ? `Differences: ${failures.join(", ")}` : "",
  "",
];
await Bun.write(outPath, [...header, ...lines].join("\n"));
console.log(`${pass} match, ${fail} differ → ${outPath}`);
if (failures.length) console.log("differ:", failures.join(" "));
