import ApplicationServices
import AppKit
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
let app = NSRunningApplication.runningApplications(withBundleIdentifier: "net.shinyfrog.bear").first!
let ax = AXUIElementCreateApplication(app.processIdentifier)
var ta: AXUIElement?
func find(_ e: AXUIElement) { if ta != nil {return}; if (attr(e, kAXRoleAttribute) as? String) == "AXTextArea" { ta = e; return }; for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { find(k) } }
for w in (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { find(w) }
let t = ta!
let s = attr(t, kAXValueAttribute) as? String ?? ""
var r = CFRange(location: 0, length: (s as NSString).length); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
let e = AXUIElementCopyParameterizedAttributeValue(t, "AXRTFForRange" as CFString, v, &o)
print("err", e.rawValue)
if let d = o as? Data { try! d.write(to: URL(fileURLWithPath: "/tmp/bear.rtf")); print("bytes", d.count)
  let a = try! NSAttributedString(data: d, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
  a.enumerateAttributes(in: NSRange(location:0,length:a.length)) { dd, rr, _ in
    let txt = (a.string as NSString).substring(with: rr)
    var parts: [String] = []
    if let f = dd[.font] as? NSFont { parts.append("\(f.fontName)@\(f.pointSize)") }
    if let c = (dd[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB) { parts.append(String(format:"fg#%02X%02X%02X a%.2f", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255), c.alphaComponent)) }
    if let c = (dd[.backgroundColor] as? NSColor)?.usingColorSpace(.sRGB) { parts.append(String(format:"bg#%02X%02X%02X", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255))) }
    if let p = dd[.paragraphStyle] as? NSParagraphStyle { parts.append(String(format:"para(lh×%.2f min%.1f max%.1f before%.1f after%.1f head%.1f first%.1f)", p.lineHeightMultiple, p.minimumLineHeight, p.maximumLineHeight, p.paragraphSpacingBefore, p.paragraphSpacing, p.headIndent, p.firstLineHeadIndent)) }
    for k in dd.keys where ![.font, .foregroundColor, .backgroundColor, .paragraphStyle].contains(k) { parts.append("\(k.rawValue)=\(dd[k]!)") }
    print("[\(rr.location),\(rr.length)] \(txt.debugDescription.prefix(60)) :: \(parts.joined(separator: " "))")
  }
}
