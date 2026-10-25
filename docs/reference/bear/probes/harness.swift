app.activate(options: [])
usleep(400000)
AXUIElementSetAttributeValue(t, kAXFocusedAttribute as CFString, kCFBooleanTrue)
func guardNote() { if !text().hasPrefix("\u{FFFC}ZZ opencode render test") { print("ABORT: wrong note open"); exit(2) } }
func getSel() -> Int { guard let v = attr(t, kAXSelectedTextRangeAttribute) else { return -1 }; var r = CFRange(); AXValueGetValue(v as! AXValue, .cfRange, &r); return r.location }
func rtf() -> NSAttributedString? {
  var r = CFRange(location: 0, length: (text() as NSString).length); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
  AXUIElementCopyParameterizedAttributeValue(t, "AXRTFForRange" as CFString, v, &o)
  guard let d = o as? Data else { return nil }; return try? NSAttributedString(data: d, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) }
func lineOfSel() -> Int { let s = text() as NSString; let p = max(0, min(getSel(), s.length)); return s.substring(to: p).components(separatedBy: "\n").count - 1 }
func dumpLine(_ n: Int, _ label: String) {
  let axLines = text().components(separatedBy: "\n")
  print("== \(label) | sel=\(getSel()) | AX line \(n): \(n < axLines.count ? axLines[n].debugDescription : "-")")
  guard let a = rtf() else { print("  no rtf"); return }
  let lines = a.string.components(separatedBy: "\n"); guard n < lines.count else { return }
  var start = 0; for i in 0..<n { start += (lines[i] as NSString).length + 1 }
  let len = (lines[n] as NSString).length
  if len == 0 { print("  (empty)"); return }
  a.enumerateAttributes(in: NSRange(location: start, length: len)) { dd, rr, _ in
    let txt = (a.string as NSString).substring(with: rr); let f = dd[.font] as? NSFont
    var col = ""; if let c = (dd[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB) { col = String(format:"#%02X%02X%02X/%.2f", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255), c.alphaComponent) }
    var bg = ""; if let c = (dd[.backgroundColor] as? NSColor)?.usingColorSpace(.sRGB) { bg = String(format:" bg#%02X%02X%02X", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255)) }
    var ex = ""; if dd[.strikethroughStyle] != nil { ex += " strike" }; if dd[.underlineStyle] != nil { ex += " underline" }; if let l = dd[.link] { ex += " link=\(l)" }
    print("  \(txt.debugDescription) \(f?.fontName ?? "")@\(String(format: "%.2f", f?.pointSize ?? 0)) \(col)\(bg)\(ex)")
  }
}
let src = CGEventSource(stateID: .hidSystemState)
func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) { guardNote(); let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)!; d.flags = flags; let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)!; u.flags = flags; d.postToPid(app.processIdentifier); u.postToPid(app.processIdentifier); usleep(250000) }
func type(_ s: String) { for ch in s { guardNote(); let u = Array(String(ch).utf16); let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!; d.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u); let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!; up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u); d.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier); usleep(250000) } }
func at(_ needle: String, _ off: Int, _ label: String) { guardNote(); let s = text() as NSString; let r = s.range(of: needle); if r.location == NSNotFound { print("?? not found \(needle)"); return }; setSel(r.location + off); usleep(450000); dumpLine(lineOfSel(), label) }
