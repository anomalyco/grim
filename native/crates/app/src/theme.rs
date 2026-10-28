//! Colours, metrics and type styles, taken from the web editor (editor.css, light theme).

use rune::{Color, TextStyle};

pub fn c(hex: &str) -> Color {
    rune::color::hex(hex).unwrap_or(Color::WHITE)
}

pub const PAPER: &str = "#fcfcfb";
pub const INK: &str = "#1d1e22";
pub const INK_LIGHT: &str = "#414141";
pub const LINK: &str = "#296d9a";
pub const MARKER: &str = "#62626a";
pub const BG2: &str = "#ececee";
pub const CODE_BG: &str = "#f1f1f2";
pub const STROKE: &str = "#d4d4d8";
pub const HEAD_RULE: &str = "#c4c4ca";
/// A collapsed link's pencil, and under the pointer.
pub const PENCIL: &str = "#a1a1aa";
pub const PENCIL_HOVER: &str = "#52525b";
/// The drop caret (macOS system blue).
pub const ACCENT: &str = "#007aff";

// The sidebar, from the web app's app.css.
pub const PAPER_2: &str = "#f4f4f5";
pub const TINT_HOVER: &str = "#ececee";
pub const TINT_ACTIVE: &str = "#e4e4e7";
pub const INK_2: &str = "#3f3f46";
pub const MUTED: &str = "#62626a";
// Dialogs, from app.css: `--paper-3`, `--grey` (field borders), `--warn-soft` (errors).
pub const PAPER_3: &str = "#ebebed";
pub const GREY: &str = "#8b8b93";
pub const WARN_SOFT: &str = "#f5c54242";

/// Hairline around the filter field.
pub fn line() -> Color {
    c("#18181b").alpha(0.12)
}

pub const SIDEBAR_W: f32 = 272.0;
/// Below this window width the sidebar starts hidden (Cmd-\ still shows it).
pub const NARROW_W: f32 = 700.0;

pub fn selection() -> Color {
    c(LINK).alpha(0.18)
}

pub fn highlight() -> Color {
    c("#f5c542").alpha(0.3)
}

/// Width of one gutter slot (list token, indent level).
pub const GUTTER: f32 = 33.0;
/// The text column's widest and narrowest widths: it follows the window in between
/// (`layout::col_w`). The narrowest only binds beside the sidebar in a narrow window, where the
/// column squeezes into what's left of the smallest window.
pub const MAX_TEXT_W: f32 = 767.0;
pub const MIN_TEXT_W: f32 = 100.0;
/// How wide a code block or a table may break out of the text column (both sides), then they scroll inside
/// themselves (provisional: the web's numbers will replace them). Never wider than the pane less
/// `WIDE_GAP` each side.
pub const CODE_MAX_W: f32 = 1000.0;
pub const TABLE_MAX_W: f32 = 1400.0;
pub const WIDE_GAP: f32 = 16.0;
pub const PAD_L: f32 = GUTTER + 16.0;
pub const PAD_R: f32 = 24.0;
pub const PAD_T: f32 = 40.0;
pub const PAD_B: f32 = 240.0;
/// Space kept clear above and below the caret when keyboard moves scroll it into view.
pub const CARET_MARGIN: f32 = 24.0;

/// Code block inner padding (left and right).
pub const CODE_PAD: f32 = 14.0;
/// Table cell right padding and vertical padding.
pub const CELL_PAD_R: f32 = 18.0;
pub const CELL_PAD_Y: f32 = 4.0;

pub const BODY_SIZE: f32 = 16.0;
pub const BOLD: f32 = 700.0;

pub fn body() -> TextStyle {
    TextStyle::new(BODY_SIZE, 400.0).lh(26.0)
}

pub fn code_block() -> TextStyle {
    TextStyle::new(13.5, 400.0).lh(21.0).mono()
}

/// Heading style plus padding above and below (0.5em / 0.3em).
pub fn heading(level: u8) -> (TextStyle, f32, f32) {
    let (size, lh, tracking) = match level {
        1 => (32.0, 1.1, -0.024),
        2 => (23.5, 1.2, -0.02),
        3 => (18.0, 1.2, -0.01),
        4 => (16.0, 1.2, 0.0),
        _ => (12.8, 1.2, 0.005),
    };
    let weight = if level == 1 { 700.0 } else { 600.0 };
    let style = TextStyle::new(size, weight).lh((size * lh as f32).round()).tracking(size * tracking);
    (style, (size * 0.5).round(), (size * 0.3).round())
}
