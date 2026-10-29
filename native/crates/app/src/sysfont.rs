//! The macOS system font (San Francisco) from the system at runtime, never bundled: CoreText says where its files
//! are (`kCTFontUIFontSystem` → `kCTFontURLAttribute`, and the italic), so it follows the macOS version. It's a
//! variable font (`wght`, `opsz`) with a `trak` table: Rune picks the weight on `wght`, sets `opsz` to each run's
//! point size (Text shapes for body, Display for headings) and applies `trak` at that size, as CoreText does.

use std::path::PathBuf;

/// The system font's family name in its files (`name` id 1).
pub const FAMILY: &str = "System Font";

/// The system font's upright and italic files.
pub fn files() -> Option<(PathBuf, Option<PathBuf>)> {
    #[cfg(target_os = "macos")]
    if let Some(found) = core_text::files() {
        return Some(found);
    }
    let up = PathBuf::from("/System/Library/Fonts/SFNS.ttf");
    let it = PathBuf::from("/System/Library/Fonts/SFNSItalic.ttf");
    up.is_file().then(|| (up, it.is_file().then_some(it)))
}

#[cfg(target_os = "macos")]
mod core_text {
    use std::ffi::{CStr, c_char, c_void};
    use std::path::PathBuf;

    type Ref = *const c_void;
    const UI_FONT_SYSTEM: u32 = 2;
    const ITALIC_TRAIT: u32 = 1;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Ref);
        fn CFURLGetFileSystemRepresentation(url: Ref, resolve: u8, buffer: *mut u8, len: isize) -> u8;
    }

    #[link(name = "CoreText", kind = "framework")]
    unsafe extern "C" {
        static kCTFontURLAttribute: Ref;
        fn CTFontCreateUIFontForLanguage(kind: u32, size: f64, language: Ref) -> Ref;
        fn CTFontCreateCopyWithSymbolicTraits(font: Ref, size: f64, matrix: Ref, value: u32, mask: u32) -> Ref;
        fn CTFontCopyAttribute(font: Ref, attribute: Ref) -> Ref;
    }

    fn path_of(font: Ref) -> Option<PathBuf> {
        if font.is_null() {
            return None;
        }
        unsafe {
            let url = CTFontCopyAttribute(font, kCTFontURLAttribute);
            if url.is_null() {
                return None;
            }
            let mut buf = [0u8; 1024];
            let ok = CFURLGetFileSystemRepresentation(url, 1, buf.as_mut_ptr(), buf.len() as isize);
            CFRelease(url);
            if ok == 0 {
                return None;
            }
            let s = CStr::from_ptr(buf.as_ptr() as *const c_char).to_str().ok()?;
            Some(PathBuf::from(s)).filter(|p| p.is_file())
        }
    }

    pub fn files() -> Option<(PathBuf, Option<PathBuf>)> {
        unsafe {
            let font = CTFontCreateUIFontForLanguage(UI_FONT_SYSTEM, 16.0, std::ptr::null());
            let up = path_of(font)?;
            let italic = CTFontCreateCopyWithSymbolicTraits(font, 0.0, std::ptr::null(), ITALIC_TRAIT, ITALIC_TRAIT);
            let it = path_of(italic).filter(|p| *p != up);
            if !italic.is_null() {
                CFRelease(italic);
            }
            CFRelease(font);
            Some((up, it))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_text_finds_the_system_fonts_files() {
        if !cfg!(target_os = "macos") {
            return;
        }
        let (up, it) = files().expect("the system font");
        assert!(up.is_file(), "{up:?}");
        println!("SYSTEM FONT {up:?} italic {it:?}");
    }

    /// Rune's layout of a line in the app's fonts (the system font) against CoreText's (`scripts/sf-dump.swift`,
    /// NSFont.systemFont), glyph by glyph: the same glyphs (so the same optical-size instance) at the same x (so the
    /// same `trak` tracking and kerning), at body and heading sizes. Prints the largest |Δx|.
    /// `cargo test --release -p grimoire matches_core_text -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn the_system_font_matches_core_text() {
        let (list, sans, mono) = crate::app_fonts();
        assert_eq!(sans, FAMILY, "the system font loaded");
        let mut ts = rune::text::TextSystem::new(list, (sans, mono));
        let paragraph = "Grimoire keeps your notes in Markdown, saved to Git as you type. The quick brown fox jumps over the lazy dog: 0123456789, (x) [y] {z} — “quoted” text.";
        let heading = "Loose ends, week 43 — Typography & Tracking";
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/scripts/sf-dump.swift");
        let dir = std::env::temp_dir();
        let mut worst_all = 0.0f64;
        for (what, text, size, weight) in [("body", paragraph, 16.0f32, 400.0f32), ("bold body", paragraph, 16.0, 700.0), ("H3", heading, 18.0, 600.0), ("H2", heading, 23.5, 600.0), ("H1", heading, 32.0, 700.0), ("small UI", paragraph, 12.8, 400.0)] {
            let file = dir.join("grimoire-sf-text.txt");
            std::fs::write(&file, text).unwrap();
            let out = std::process::Command::new("swift").arg(script).arg(size.to_string()).arg((weight as u32).to_string()).arg(&file).output().expect("swift");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let ct: Vec<(u32, f64)> = String::from_utf8(out.stdout).unwrap().lines().filter(|l| !l.starts_with("width")).map(|l| {
                let mut p = l.split('\t');
                (p.next().unwrap().parse().unwrap(), p.next().unwrap().parse().unwrap())
            }).collect();
            // the app's weights as AppKit takes them (600 → Semibold, wght 590)
            let layout = ts.layout_rich(text, &[], rune::TextStyle::new(size, crate::theme::sf_weight(weight)), 1.0, None);
            let mut ours: Vec<(u32, f64)> = Vec::new();
            for line in layout.lines() {
                for item in line.items() {
                    if let parley::PositionedLayoutItem::GlyphRun(run) = item {
                        for g in run.positioned_glyphs() {
                            ours.push((g.id, f64::from(g.x)));
                        }
                    }
                }
            }
            assert_eq!(ours.len(), ct.len(), "{what}: glyph counts");
            let same_glyphs = ours.iter().zip(&ct).all(|(a, b)| a.0 == b.0);
            if std::env::var("SF_DEBUG").is_ok() {
                let mut prev = 0.0;
                for (i, (a, b)) in ours.iter().zip(&ct).enumerate() {
                    let d = a.1 - b.1;
                    if (d - prev).abs() > 0.001 {
                        println!("  {what} glyph {i} id {} Δx {d:.4} (step {:.4}) char {:?}", a.0, d - prev, text.chars().nth(i));
                    }
                    prev = d;
                }
            }
            let worst = ours.iter().zip(&ct).map(|(a, b)| (a.1 - b.1).abs()).fold(0.0, f64::max);
            println!("SF {what:9} {size:>5} pt wght {weight:>3}: {} glyphs, same glyphs {same_glyphs}, max |Δx| {worst:.4} pt, end {:.3} vs CoreText {:.3}", ours.len(), ours.last().unwrap().1, ct.last().unwrap().1);
            assert!(same_glyphs, "{what}: CoreText shaped other glyphs (another optical-size instance?)");
            if weight == 400.0 {
                // the font's default instance: the same layout exactly (opsz, `trak` and kerning as CoreText)
                assert!(worst < 0.01, "{what}: max |Δx| {worst:.4} pt");
                worst_all = worst_all.max(worst);
            } else {
                // another instance on `wght`: Rune's shaping rounds each interpolated advance to a whole font
                // unit (1/2048 em), CoreText keeps the fraction: at most half a unit a glyph, drifting
                assert!(worst / ours.len() as f64 <= 0.5 * f64::from(size) / 2048.0, "{what}: {worst:.4} pt over {} glyphs", ours.len());
            }
        }
        println!("SF regular: max |Δx| {worst_all:.4} pt");
    }

    /// CoreText's optical size is the point size clamped to the font's `opsz` axis (SF on macOS 15: 17–96, default 28;
    /// `NSFont.systemFont`: 9–17 pt → 17, 18 → 18, 23.5 → 23.5, 32 → 32, 120 → 96). Rune's default asks for the point
    /// size and a coordinate below the axis is clamped, so below 17 pt it's already CoreText's instance: at 12.8, 14
    /// and 16 pt the default lays out and rasterises (4×) exactly as `opsz` 17 does, advances and glyph boxes alike,
    /// while `opsz` 20 doesn't (the comparison sees optical size).
    /// `cargo test --release -p grimoire axis_clamps -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn rune_opsz_below_the_axis_clamps_like_core_text() {
        let (list, sans, mono) = crate::app_fonts();
        assert_eq!(sans, FAMILY);
        let mut ts = rune::text::TextSystem::new(list, (sans, mono));
        let text = "Hamburgefonstiv 0123456789 aeg ffi Welcome to Grimoire";
        let mut shape = |style: rune::TextStyle| {
            let layout = ts.layout_rich(text, &[], style, 4.0, None);
            let mut adv = Vec::new();
            for line in layout.lines() {
                for item in line.items() {
                    if let parley::PositionedLayoutItem::GlyphRun(run) = item {
                        for g in run.positioned_glyphs() {
                            adv.push(g.x);
                        }
                    }
                }
            }
            let mut quads = Vec::new();
            ts.glyphs(text, style, 4.0, [0.0, 0.0], &mut quads);
            (adv, quads.iter().map(|q| q.rect).collect::<Vec<_>>())
        };
        for size in [12.8f32, 14.0, 16.0] {
            for weight in [400.0f32, 590.0, 700.0] {
                let base = rune::TextStyle::new(size, weight);
                let auto = shape(base);
                let same = auto == shape(base.variations("'opsz' 17"));
                let differs = auto != shape(base.variations("'opsz' 20"));
                println!("OPSZ {size:>4} pt wght {weight}: Rune's default = CoreText's opsz 17 (advances, glyph boxes): {same}; opsz 20 differs: {differs}");
                assert!(same && differs);
            }
        }
    }
}
