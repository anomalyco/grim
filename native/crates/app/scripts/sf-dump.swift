// CoreText's layout of a line in the macOS system font, as AppKit draws it (NSFont.systemFont: optical size and
// `trak` tracking at the point size): one "glyph<TAB>x" per glyph, x in points from the line's start.
// usage: swift sf-dump.swift SIZE WEIGHT TEXTFILE   (WEIGHT 400, 500, 600 or 700)
import AppKit
import CoreText

let a = CommandLine.arguments
let size = CGFloat(Double(a[1])!)
let weight: NSFont.Weight = [400: .regular, 500: .medium, 600: .semibold, 700: .bold][Int(a[2])!]!
let text = try! String(contentsOfFile: a[3], encoding: .utf8).trimmingCharacters(in: .newlines)
let font = NSFont.systemFont(ofSize: size, weight: weight)
let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
var out = ""
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
    let n = CTRunGetGlyphCount(run)
    var g = [CGGlyph](repeating: 0, count: n), p = [CGPoint](repeating: .zero, count: n)
    CTRunGetGlyphs(run, CFRange(location: 0, length: n), &g)
    CTRunGetPositions(run, CFRange(location: 0, length: n), &p)
    for i in 0..<n { out += "\(g[i])\t\(String(format: "%.4f", p[i].x))\n" }
}
out += "width\t\(String(format: "%.4f", CTLineGetTypographicBounds(line, nil, nil, nil)))\n"
print(out, terminator: "")
