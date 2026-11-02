// Grim Beta's icon from Grim's (scripts/bundle.sh --beta): the scratches tinted orange, and at 1024 px a "BETA"
// label under them. Writes AppIcon-Beta-1024.png, AppIcon-Beta-16.png and AppIcon-Beta-32.png beside the originals;
// make-icns.sh --beta turns them into AppIcon-Beta.icns. Run from packaging/: swift make-beta-icon.swift
import AppKit
import CoreGraphics
import CoreText

let orange: (CGFloat, CGFloat, CGFloat) = (255, 159, 10)

func load(_ path: String) -> CGImage {
    let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(src, 0, nil)!
}

func save(_ img: CGImage, _ path: String) {
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}

func beta(_ input: String, _ output: String, label: Bool) {
    let img = load(input)
    let (w, h) = (img.width, img.height)
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let px = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
    // the light scratches (and their antialiased edges) blend from the dark body to orange by their lightness
    for i in 0..<(w * h) {
        let a = CGFloat(px[i * 4 + 3])
        if a < 1 { continue }
        let r = CGFloat(px[i * 4]) * 255 / a, g = CGFloat(px[i * 4 + 1]) * 255 / a, b = CGFloat(px[i * 4 + 2]) * 255 / a
        let l = max(0, min(1, ((r + g + b) / 3 - 17) / (246 - 17)))
        if l <= 0 { continue }
        let mix = { (dark: CGFloat, o: CGFloat) -> UInt8 in UInt8(max(0, min(255, (dark * (1 - l) + o * l) * a / 255))) }
        px[i * 4] = mix(17, orange.0)
        px[i * 4 + 1] = mix(17, orange.1)
        px[i * 4 + 2] = mix(17, orange.2)
    }
    if label {
        let s = CGFloat(w) / 1024
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 150 * s, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: CGColor(srgbRed: 1, green: 159 / 255, blue: 10 / 255, alpha: 1),
            .kern: 18 * s,
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: "BETA", attributes: attrs))
        let bounds = CTLineGetImageBounds(line, ctx)
        ctx.textPosition = CGPoint(x: (CGFloat(w) - bounds.width) / 2 - bounds.minX, y: 175 * s)
        CTLineDraw(line, ctx)
    }
    save(ctx.makeImage()!, output)
}

beta("AppIcon-1024.png", "AppIcon-Beta-1024.png", label: true)
beta("AppIcon-32.png", "AppIcon-Beta-32.png", label: false)
beta("AppIcon-16.png", "AppIcon-Beta-16.png", label: false)
print("wrote AppIcon-Beta-1024.png, AppIcon-Beta-32.png, AppIcon-Beta-16.png")
