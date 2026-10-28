import ApplicationServices
import AppKit
setvbuf(stdout, nil, _IONBF, 0)
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
let app = NSRunningApplication.runningApplications(withBundleIdentifier: "net.shinyfrog.bear").first!
let ax = AXUIElementCreateApplication(app.processIdentifier)
var ta: AXUIElement?
func find(_ e: AXUIElement) { if ta != nil {return}; if (attr(e, kAXRoleAttribute) as? String) == "AXTextArea" { ta = e; return }; for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { find(k) } }
for w in (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { find(w) }
let t = ta!
func text() -> String { attr(t, kAXValueAttribute) as? String ?? "" }
func setSel(_ loc: Int, _ len: Int = 0) { var r = CFRange(location: loc, length: len); AXUIElementSetAttributeValue(t, kAXSelectedTextRangeAttribute as CFString, AXValueCreate(.cfRange, &r)!) }
func runs(_ from: Int, _ to: Int) {
  var r = CFRange(location: 0, length: (text() as NSString).length); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
  AXUIElementCopyParameterizedAttributeValue(t, "AXRTFForRange" as CFString, v, &o)
  guard let d = o as? Data, let a = try? NSAttributedString(data: d, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) else { print("no rtf"); return }
  a.enumerateAttributes(in: NSRange(location:0,length:a.length)) { dd, rr, _ in
    if rr.location + rr.length <= from || rr.location >= to { return }
    let txt = (a.string as NSString).substring(with: rr)
    let f = dd[.font] as? NSFont
    var col = ""; if let c = (dd[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB) { col = String(format:"#%02X%02X%02X/%.2f", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255), c.alphaComponent) }
    print("  [\(rr.location),\(rr.length)] \(txt.debugDescription) \(f?.fontName ?? "")@\(f?.pointSize ?? 0) \(col)")
  }
}
