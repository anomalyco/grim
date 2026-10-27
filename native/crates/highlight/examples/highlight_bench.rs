//! Tokenizing cost in Wasmi: `cargo run --release -p highlight --example highlight_bench`.
//! A 500-line TypeScript block: module compile, first tokenization, then single-character edits
//! (typing in the middle, at the top, opening a block comment that re-lexes everything below).

use std::time::Instant;

use highlight::{Highlighter, lang_id};

fn main() {
    let t0 = Instant::now();
    let hl = Highlighter::new().unwrap();
    println!("compile module: {:.2} ms", ms(t0));
    let chunk = "export async function load(path: string, n = 3): Promise<Note[]> {\n  const text = await readFile(path, \"utf8\"); // read it\n  return text.split(/\\n/).map((l, i) => ({ i, l: l.trim() })).slice(0, n * 0x10);\n}\n\n";
    let mut text = chunk.repeat(100);
    assert_eq!(text.lines().count(), 500);
    let ts = lang_id("ts").unwrap();
    let t0 = Instant::now();
    let mut t = hl.tokenizer(ts, &text).unwrap();
    println!("first tokenize, 500 lines ({} bytes): {:.2} ms", text.len(), ms(t0));
    for (name, at) in [("middle", text.len() / 2 - 3), ("top", 10)] {
        let mut total = 0.0;
        let mut worst = 0.0f64;
        let n = 50;
        for i in 0..n {
            let at = at + i;
            text.insert(at, 'x');
            let t0 = Instant::now();
            t.set_text(&text).unwrap();
            let d = ms(t0);
            total += d;
            worst = worst.max(d);
        }
        println!("type a character ({name}): {:.3} ms average, {:.3} ms worst", total / n as f64, worst);
    }
    let t0 = Instant::now();
    let mut opened = text.clone();
    opened.insert_str(0, "/*");
    t.set_text(&opened).unwrap();
    println!("open a block comment at the top (re-lex all 500 lines): {:.2} ms", ms(t0));
    let t0 = Instant::now();
    t.set_text(&text).unwrap();
    println!("close it again: {:.2} ms", ms(t0));
    let t0 = Instant::now();
    for _ in 0..100 {
        assert_eq!(t.set_text(&text).unwrap(), None);
    }
    println!("unchanged text (compare only): {:.4} ms", ms(t0) / 100.0);
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}
