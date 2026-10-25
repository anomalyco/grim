func compact(_ n: Int, _ label: String) {
  let axLines = text().components(separatedBy: "\n")
  guard let a = rtf() else { print("no rtf"); return }
  let lines = a.string.components(separatedBy: "\n"); guard n < lines.count else { return }
  var start = 0; for i in 0..<n { start += (lines[i] as NSString).length + 1 }
  let len = (lines[n] as NSString).length
  var out = ""; var meta: [String] = []
  if len > 0 { a.enumerateAttributes(in: NSRange(location: start, length: len)) { dd, rr, _ in
    let txt = (a.string as NSString).substring(with: rr); let f = dd[.font] as? NSFont; let sz = f?.pointSize ?? 0
    var col = ""; if let c = (dd[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB) { col = String(format:"#%02X%02X%02X", Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255)) }
    if sz < 0.1 { out += "·" } else if col == "#D8D8D8" { out += "‹\(txt)›"; meta.append("‹\(txt)› \(f!.fontName)@\(String(format:"%.1f",sz))") } else { out += txt; if sz != 15 { meta.append("\(txt.prefix(12))@\(String(format:"%.2f",sz)) \(col)") } else if col != "#444444" { meta.append("\(txt.prefix(12)) \(col)") } }
  } }
  print("== \(label)\n   AX: \(n < axLines.count ? axLines[n].debugDescription : "-")\n   view: \(out)\n   \(meta.joined(separator: " | "))")
}
func at2(_ needle: String, _ off: Int, _ label: String) { guardNote(); let s = text() as NSString; let r = s.range(of: needle); if r.location == NSNotFound { print("?? not found \(needle)"); return }; setSel(r.location + off); usleep(450000); compact(lineOfSel(), label) }
