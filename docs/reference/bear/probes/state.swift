func caret() -> String {
  var r = CFRange(location: getSel(), length: 0); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
  AXUIElementCopyParameterizedAttributeValue(t, kAXBoundsForRangeParameterizedAttribute as CFString, v, &o)
  guard let o = o else { return "?" }; var rect = CGRect.zero; AXValueGetValue(o as! AXValue, .cgRect, &rect)
  return String(format: "x=%.0f y=%.0f h=%.0f", rect.origin.x, rect.origin.y, rect.height) }
func colInLine() -> Int { let s = text() as NSString; let p = min(getSel(), s.length); let before = s.substring(to: p); let ls = (before as NSString).range(of: "\n", options: .backwards); return ls.location == NSNotFound ? p : p - ls.location - 1 }
func st(_ label: String) { usleep(300000); let n = lineOfSel(); let axLines = text().components(separatedBy: "\n")
  var view = ""; var meta: [String] = []
  if let a = rtf() { let lines = a.string.components(separatedBy: "\n"); if n < lines.count { var start = 0; for i in 0..<n { start += (lines[i] as NSString).length + 1 }; let len = (lines[n] as NSString).length
    if len > 0 { a.enumerateAttributes(in: NSRange(location: start, length: len)) { dd, rr, _ in
      let txt = (a.string as NSString).substring(with: rr); let f = dd[.font] as? NSFont; let sz = f?.pointSize ?? 0
      var col = ""; if let c = (dd[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB) { col = String(format:"#%02X%02X%02X", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255)) }
      if sz < 0.1 { view += "·" } else if col == "#D8D8D8" { view += "‹\(txt)›" } else { view += txt; let fn = f?.fontName ?? ""; if fn.contains("Bold") || fn.contains("Oblique") || sz != 15 || col != "#444444" { meta.append("\(txt.prefix(10)):\(fn.replacingOccurrences(of: "Helvetica", with: "H"))@\(String(format:"%.0f",sz))\(col == "#444444" ? "" : col)") } }
    } } } }
  print(String(format: "%-34@", label as NSString) + " L\(n) c\(colInLine()) sel=\(getSel()) \(caret()) | AX=\(n < axLines.count ? axLines[n].debugDescription : "-") | view=\(view) \(meta.isEmpty ? "" : "{" + meta.joined(separator: " ") + "}")") }
let RET: CGKeyCode = 36, BS: CGKeyCode = 51, LEFT: CGKeyCode = 123, RIGHT: CGKeyCode = 124, DOWN: CGKeyCode = 125, UP: CGKeyCode = 126, ZKEY: CGKeyCode = 6, TAB: CGKeyCode = 48
func endOfDoc() { setSel((text() as NSString).length); usleep(300000) }
func selLen() -> Int { guard let v = attr(t, kAXSelectedTextRangeAttribute) else { return -1 }; var r = CFRange(); AXValueGetValue(v as! AXValue, .cfRange, &r); return r.length }
func selText() -> String { let s = text() as NSString; guard let v = attr(t, kAXSelectedTextRangeAttribute) else { return "" }; var r = CFRange(); AXValueGetValue(v as! AXValue, .cfRange, &r); if r.length == 0 || r.location + r.length > s.length { return "" }; return s.substring(with: NSRange(location: r.location, length: r.length)) }
let HOME: CGKeyCode = 115, END: CGKeyCode = 119, FDEL: CGKeyCode = 117, BKEY: CGKeyCode = 11, IKEY: CGKeyCode = 34, AKEY: CGKeyCode = 0, VKEY: CGKeyCode = 9
func click(_ p: CGPoint, _ n: Int = 1) { for c in 1...n { for ty in [CGEventType.leftMouseDown, .leftMouseUp] { let e = CGEvent(mouseEventSource: src, mouseType: ty, mouseCursorPosition: p, mouseButton: .left)!; e.setIntegerValueField(.mouseEventClickState, value: Int64(c)); e.post(tap: .cghidEventTap); usleep(30000) } }; usleep(350000) }
func charRect(_ i: Int) -> CGRect { var r = CFRange(location: i, length: 1); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?; AXUIElementCopyParameterizedAttributeValue(t, kAXBoundsForRangeParameterizedAttribute as CFString, v, &o); var rect = CGRect.zero; if let o = o { AXValueGetValue(o as! AXValue, .cgRect, &rect) }; return rect }
func sx(_ label: String) { st(label + " [selLen=\(selLen()) sel=\(selText().debugDescription)]") }
