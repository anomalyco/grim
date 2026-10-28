func caretRect() -> CGRect {
  var r = CFRange(location: getSel(), length: 0); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
  AXUIElementCopyParameterizedAttributeValue(t, kAXBoundsForRangeParameterizedAttribute as CFString, v, &o)
  var rect = CGRect.zero; if let o = o { AXValueGetValue(o as! AXValue, .cgRect, &rect) }; return rect }
var shotList: [(String, String)] = []
let home = FileManager.default.homeDirectoryForCurrentUser.path
func shot(_ label: String, rows: Int = 1) {
  usleep(350000)
  let c = caretRect(); let name = "/tmp/bshots/\(String(format: "%03d", shotList.count)).png"
  try? FileManager.default.removeItem(atPath: name)
  let y = max(0, Int(c.origin.y) - 24 - (rows-1)*14); let h = 70 + (rows-1) * 28
  try! "-R 370,\(y),860,\(h)".write(toFile: home + "/.bearshot/args", atomically: true, encoding: .utf8)
  try! name.write(toFile: home + "/.bearshot/req", atomically: true, encoding: .utf8)
  for _ in 0..<60 { if FileManager.default.fileExists(atPath: name) { break }; usleep(100000) }
  shotList.append((name, label)); print("SHOT \(name) \(label)") }
func caretMark() -> String { "" }
let noteID = "036C2A3B-E7CA-447C-939D-578188C41B2D"
func reset(_ body: String) {
  let q = body.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
  NSWorkspace.shared.open(URL(string: "bear://x-callback-url/add-text?id=\(noteID)&mode=replace&open_note=yes&text=\(q)")!)
  usleep(1500000); app.activate(options: []); usleep(400000)
  AXUIElementSetAttributeValue(t, kAXFocusedAttribute as CFString, kCFBooleanTrue); guardNote() }
func lineStart(_ needle: String, _ off: Int = 0) { let s = text() as NSString; let after = s.range(of: "\n").location + 1; let r = s.range(of: needle, options: [], range: NSRange(location: after, length: s.length - after)); if r.location == NSNotFound { print("?? not found \(needle)"); return }; setSel(r.location + off); usleep(350000) }
func finish() { var k = 0; var idx = 0; while idx < shotList.count { montage(Array(shotList[idx..<min(idx+7, shotList.count)]), k, idx); idx += 7; k += 1 } }
func montage(_ part: [(String, String)], _ k: Int, _ base: Int) {
  var imgs: [(NSImage, String)] = []
  for (p, l) in part { if let i = NSImage(contentsOfFile: p) { imgs.append((i, l)) } }
  guard !imgs.isEmpty else { return }
  let W: CGFloat = 860, labelH: CGFloat = 26
  let H = imgs.reduce(0) { $0 + $1.0.size.height + labelH }
  let out = NSImage(size: NSSize(width: W, height: H)); out.lockFocus()
  NSColor.white.setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
  var y = H
  for (i, (img, l)) in imgs.enumerated() {
    y -= labelH; NSColor(calibratedWhite: 0.15, alpha: 1).setFill(); NSRect(x: 0, y: y, width: W, height: labelH).fill()
    ("#\(base+i) " + l as NSString).draw(at: NSPoint(x: 6, y: y + 5), withAttributes: [.font: NSFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: NSColor.white])
    y -= img.size.height; img.draw(in: NSRect(x: 0, y: y, width: W, height: img.size.height)) }
  out.unlockFocus()
  let rep = NSBitmapImageRep(data: out.tiffRepresentation!)!; try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "/tmp/bshots/montage-\(k).png"))
  print("MONTAGE \(k)") }
