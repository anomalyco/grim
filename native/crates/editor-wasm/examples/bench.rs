//! Per-keystroke cost of the engine on a big document, natively (no wasm, no serialization to JS).
//! Usage: cargo run --release -p editor-wasm --example bench -- [doc.md]
//! (the web repo's `bun tools/perf/bigdoc.mjs <file>` writes the 3000-line mixed document; without a file a
//! generated one is used).

use std::time::Instant;

use editor_core::text::byte_to_utf16;
use editor_wasm::Engine;

fn main() {
    let text = match std::env::args().nth(1) {
        Some(p) => std::fs::read_to_string(p).expect("read doc"),
        None => (0..3000).map(|i| if i % 5 == 0 { format!("- item **{i}** text") } else { format!("line {i} with *some* text") }).collect::<Vec<_>>().join("\n"),
    };
    let n_lines = text.lines().count();
    println!("{} lines, {} bytes", n_lines, text.len());
    let starts: Vec<usize> = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect();
    for (name, line) in [("top", 1), ("middle", n_lines / 2 + 1), ("bottom", n_lines - 29)] {
        let line = line.min(n_lines - 1);
        let end = starts.get(line + 1).map_or(text.len(), |&s| s - 1);
        let pos = byte_to_utf16(&text, end.saturating_sub(1)) as u32;
        let mut e = Engine::new(&text);
        e.render_all_rs();
        e.set_selection_rs(pos, pos);
        let n = 50;
        let mut sent = 0;
        let t0 = Instant::now();
        for i in 0..n {
            let p = e.insert_text_rs(if i % 2 == 0 { "a" } else { "b" });
            sent += p.lines.map_or(0, |l| l.insert.len());
        }
        let total = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        // the parts: the edit itself (incl. the incremental reparse), and a full render_lines for comparison
        let mut ed = e.editor().clone();
        let t0 = Instant::now();
        for _ in 0..n {
            ed.insert_text("c");
        }
        let edit = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        let t0 = Instant::now();
        for _ in 0..n {
            std::hint::black_box(ed.render_lines());
        }
        let render = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        println!(
            "{name:>6} (line {line}): keystroke {total:.3} ms  [edit+reparse {edit:.3} ms, full render_lines {render:.3} ms (not done per keystroke)]  lines sent/keystroke {:.1}",
            sent as f64 / n as f64
        );
    }
}
