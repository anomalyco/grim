// A deterministic 3000-line mixed Markdown document for the keystroke benchmarks (tools/perf/keystroke.mjs and
// the native bench in grimoire-native crates/editor-wasm/examples/bench.rs, which reads it from a file).
const BLOCK = (k) => [
  `## Section ${k}`,
  `Paragraph ${k} with **bold**, *italic*, \`code\` and a [link](https://example.com/${k}) in it.`,
  `Second line of the paragraph with ~~strike~~, ==mark== and #tag${k} text.`,
  ``,
  `- bullet one with **strong** words`,
  `- bullet two`,
  `\t- nested bullet ${k}`,
  `- [ ] todo item ${k}`,
  `- [x] done item`,
  `1. first numbered`,
  `2. second numbered`,
  `> a quote with *emphasis* ${k}`,
  ``,
  "```js",
  `const x = ${k};`,
  `function f() { return x * 2; }`,
  "```",
  ``,
  `| col a | col b |`,
  `|-------|:-----:|`,
  `| ${k} | **two** |`,
  `| three | four |`,
  ``,
  `Plain line ${k} with some ordinary text to make it a bit longer than the others.`,
  `Another plain line, with a café and an emoji 😀 here.`,
  `---`,
  `### Sub ${k}`,
  `Text under the sub heading.`,
  `More text.`,
  ``,
];

export function bigDoc(lines = 3000) {
  const out = [];
  for (let k = 0; out.length < lines; k++) out.push(...BLOCK(k));
  return out.slice(0, lines).join("\n");
}

if (import.meta.main) await Bun.write(process.argv[2] ?? "/tmp/opencode/bigdoc.md", bigDoc());
