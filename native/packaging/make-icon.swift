// Renders the Grimoire app icon: a black ink slab (macOS rounded-square) with a white serif "G".
// Usage: swift packaging/make-icon.swift packaging/AppIcon-1024.png
import AppKit
import CoreGraphics

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
let size = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

// Apple's icon grid: 824pt body centered in 1024 canvas, ~185pt corner radius.
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let radius: CGFloat = 185
let slab = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)

// Soft drop shadow, like system icons.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28,
              color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.35))
ctx.addPath(slab)
ctx.setFillColor(CGColor(srgbRed: 0x1d / 255.0, green: 0x1e / 255.0, blue: 0x22 / 255.0, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

// Very subtle top-to-bottom sheen inside the slab.
ctx.saveGState()
ctx.addPath(slab)
ctx.clip()
let sheen = CGGradient(colorsSpace: cs, colors: [
    CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.06),
    CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.0),
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(sheen, start: CGPoint(x: 512, y: body.maxY), end: CGPoint(x: 512, y: body.midY), options: [])
ctx.restoreGState()

// Thin inner hairline to lift the edge off dark backgrounds.
ctx.saveGState()
ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 2, dy: 2), cornerWidth: radius - 2, cornerHeight: radius - 2, transform: nil))
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.08))
ctx.setLineWidth(3)
ctx.strokePath()
ctx.restoreGState()

// The "G": a heavy serif face, optically centered.
func pickFont(_ px: CGFloat) -> NSFont {
    for name in ["Rockwell-Bold", "NewYorkLarge-Black", "NewYork-Black", "Georgia-Bold", "TimesNewRomanPS-BoldMT"] {
        if let f = NSFont(name: name, size: px) { return f }
    }
    if let d = NSFont.systemFont(ofSize: px, weight: .black).fontDescriptor.withDesign(.serif),
       let f = NSFont(descriptor: d, size: px) { return f }
    return NSFont.boldSystemFont(ofSize: px)
}
let font = pickFont(600)
let attr = NSAttributedString(string: "G", attributes: [
    .font: font,
    .foregroundColor: NSColor.white,
])
let line = CTLineCreateWithAttributedString(attr)
let glyphBounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
ctx.textPosition = CGPoint(x: 512 - glyphBounds.midX, y: 512 - glyphBounds.midY + 4)
CTLineDraw(line, ctx)

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out) (font: \(font.fontName))")
