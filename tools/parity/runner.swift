// Parity runner: plays each scenario in Bear and in our editor (a separate Chrome instance driven over CDP),
// with identical native key events, and records state after every step.
// Usage (on the Mac): swift runner.swift scenarios.json out.json [bear|chrome|both] [filter]
import ApplicationServices
import AppKit
import Foundation
setvbuf(stdout, nil, _IONBF, 0)

let args = CommandLine.arguments
let scenarioPath = args.count > 1 ? args[1] : "/tmp/parity/scenarios.json"
let outPath = args.count > 2 ? args[2] : "/tmp/parity/out.json"
let mode = args.count > 3 ? args[3] : "both"
let filter = args.count > 4 ? args[4] : ""

let NOTE_ID = "036C2A3B-E7CA-447C-939D-578188C41B2D"
let TITLE = "# ZZ opencode render test (safe to delete)\n"
let DB = NSHomeDirectory() + "/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite"

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
let src = CGEventSource(stateID: .hidSystemState)

// ---------- key events ----------
let KEYS: [String: CGKeyCode] = ["RET": 36, "BS": 51, "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126, "TAB": 48, "HOME": 115, "END": 119,
  "FDEL": 117, "ESC": 53, "A": 0, "B": 11, "I": 34, "Z": 6, "V": 9, "C": 8, "X": 7, "U": 32, "S": 1, "K": 40, "SPACE": 49]
func flags(_ mods: [Substring]) -> CGEventFlags {
  var f: CGEventFlags = []
  for m in mods { switch m { case "cmd": f.insert(.maskCommand); case "alt": f.insert(.maskAlternate); case "shift": f.insert(.maskShift); case "ctrl": f.insert(.maskControl); default: break } }
  return f
}
func postKey(_ pid: pid_t, _ code: CGKeyCode, _ f: CGEventFlags) {
  let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)!; d.flags = f
  let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)!; u.flags = f
  d.postToPid(pid); u.postToPid(pid); usleep(220000)
}
func postText(_ pid: pid_t, _ s: String) {
  for ch in s {
    if ch == "\n" { postKey(pid, 36, []); continue }
    if ch == "\t" { postKey(pid, 48, []); continue }
    let u = Array(String(ch).utf16)
    let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!; d.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!; up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
    d.postToPid(pid); up.postToPid(pid); usleep(220000)
  }
}
func setClipboard(_ s: String) { let pb = NSPasteboard.general; pb.clearContents(); pb.setString(s, forType: .string) }

// ---------- target abstraction ----------
protocol Target {
  var pid: pid_t { get }
  func activate()
  func reset(_ doc: String)
  func axText() -> String
  func selection() -> (Int, Int)
  func setSelection(_ loc: Int, _ len: Int)
  func lineView() -> String
  func raw() -> String
  func caretRect() -> CGRect
}

// ---------- Bear ----------
final class BearTarget: Target {
  let app = NSRunningApplication.runningApplications(withBundleIdentifier: "net.shinyfrog.bear").first!
  var t: AXUIElement!
  var pid: pid_t { app.processIdentifier }
  init() { findTextArea() }
  func findTextArea() {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var found: AXUIElement?
    func walk(_ e: AXUIElement) { if found != nil { return }; if (attr(e, kAXRoleAttribute) as? String) == "AXTextArea" { found = e; return }; for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(k) } }
    for w in (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { walk(w) }
    guard let f = found else { print("FATAL: Bear text area not found (screen locked?)"); exit(3) }
    t = f
  }
  func activate() { app.activate(options: []); usleep(350000); AXUIElementSetAttributeValue(t, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
  func guardNote() { if !axText().hasPrefix("\u{FFFC}ZZ opencode render test") { print("ABORT: wrong Bear note open"); exit(2) } }
  func reset(_ doc: String) {
    let q = (TITLE + doc).addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
    NSWorkspace.shared.open(URL(string: "bear://x-callback-url/add-text?id=\(NOTE_ID)&mode=replace_all&open_note=yes&text=\(q)")!)
    usleep(1300000); findTextArea(); activate(); guardNote()
  }
  func axText() -> String { attr(t, kAXValueAttribute) as? String ?? "" }
  func selection() -> (Int, Int) { guard let v = attr(t, kAXSelectedTextRangeAttribute) else { return (-1, 0) }; var r = CFRange(); AXValueGetValue(v as! AXValue, .cfRange, &r); return (r.location, r.length) }
  func setSelection(_ loc: Int, _ len: Int) { var r = CFRange(location: loc, length: len); AXUIElementSetAttributeValue(t, kAXSelectedTextRangeAttribute as CFString, AXValueCreate(.cfRange, &r)!); usleep(300000) }
  func caretRect() -> CGRect {
    var r = CFRange(location: selection().0, length: 0); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
    AXUIElementCopyParameterizedAttributeValue(t, kAXBoundsForRangeParameterizedAttribute as CFString, v, &o)
    var rect = CGRect.zero; if let o = o { AXValueGetValue(o as! AXValue, .cgRect, &rect) }; return rect
  }
  func rtf() -> NSAttributedString? {
    var r = CFRange(location: 0, length: (axText() as NSString).length); let v = AXValueCreate(.cfRange, &r)!; var o: AnyObject?
    AXUIElementCopyParameterizedAttributeValue(t, "AXRTFForRange" as CFString, v, &o)
    guard let d = o as? Data else { return nil }
    return try? NSAttributedString(data: d, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
  }
  /// What the user sees on the caret's line (see VIEW FORMAT in README.md):
  /// hidden characters are omitted, a block token is "▸", a link chip is "✎", visible syntax markers are ‹x›,
  /// styled runs are ⟨FLAGS:text⟩ with flags B I S U H C, and the caret is "|" (a selection is "[...]").
  func lineView() -> String {
    let ax = axText() as NSString
    let (selLoc, selLen) = selection()
    guard let a = rtf() else { return "?" }
    let r = a.string as NSString // RTF text has no U+FFFC attachment characters; AX text does.
    // Find the caret's line in AX coordinates.
    let p = max(0, min(selLoc, ax.length))
    let lineStart = ax.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: p)).location
    let ls = lineStart == NSNotFound ? 0 : lineStart + 1
    var le = ax.range(of: "\n", options: [], range: NSRange(location: ls, length: ax.length - ls)).location
    if le == NSNotFound { le = ax.length }
    // RTF index of the line start = AX index minus attachments before it.
    var ri = 0; for i in 0..<ls where ax.character(at: i) != 0xFFFC { _ = i; ri += 1 }
    var out = ""; var curFlags = ""; var runText = ""
    func flushRun() { if !runText.isEmpty { out += curFlags.isEmpty ? runText : "⟨\(curFlags):\(runText)⟩" }; runText = "" }
    func emit(_ s: String, _ f: String) { if f != curFlags { flushRun(); curFlags = f }; runText += s }
    func caretMark(_ i: Int) {
      if selLen == 0 && i == selLoc { emit("|", curFlags) }
      if selLen > 0 && i == selLoc { emit("[", curFlags) }
      if selLen > 0 && i == selLoc + selLen { emit("]", curFlags) }
    }
    var i = ls
    while i < le {
      caretMark(i)
      let ch = ax.character(at: i)
      if ch == 0xFFFC {
        let atStart = (ls..<i).allSatisfy { ax.character(at: $0) == 0xFFFC }
        let isChip = i >= 2 && ax.substring(with: NSRange(location: i - 2, length: 2)) == "](" 
        if atStart { emit("▸", "") } else if isChip { emit("✎", "") }
        i += 1; continue
      }
      let attrs = ri < r.length ? a.attributes(at: ri, effectiveRange: nil) : [:]
      let font = attrs[.font] as? NSFont; let size = font?.pointSize ?? 15
      var col = ""; if let c = (attrs[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB) { col = String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255)) }
      let s = ax.substring(with: NSRange(location: i, length: 1))
      if size < 0.1 { /* hidden */ }
      else if col == "#D8D8D8" { emit("‹\(s)›", "") }
      else {
        let fn = font?.fontName ?? ""
        var f = ""
        if fn.contains("Bold") || fn.contains("Heavy") || fn.contains("Semibold") { f += "B" }
        if fn.contains("Oblique") || fn.contains("Italic") { f += "I" }
        if attrs[.strikethroughStyle] != nil { f += "S" }
        if attrs[.underlineStyle] != nil && attrs[.link] == nil { f += "U" }
        if let bg = (attrs[.backgroundColor] as? NSColor)?.usingColorSpace(.sRGB), bg.alphaComponent > 0.05, !(fn.contains("Mono") || fn.contains("Menlo")) { f += "H" }
        if fn.contains("Mono") || fn.contains("Menlo") || fn.contains("Courier") { f += "C" }
        emit(s, f)
      }
      ri += 1; i += 1
    }
    caretMark(le)
    flushRun()
    return out
  }
  func raw() -> String {
    usleep(2600000)
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    p.arguments = ["-readonly", DB, "select ZTEXT from ZSFNOTE where ZUNIQUEIDENTIFIER='\(NOTE_ID)';"]
    let o = Pipe(); p.standardOutput = o; try! p.run(); p.waitUntilExit()
    var s = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    if s.hasSuffix("\n") { s.removeLast() } // sqlite3 adds a newline
    return s
  }
}

// ---------- Chrome (our editor) over CDP ----------
final class CDP {
  let task: URLSessionWebSocketTask
  var nextId = 1
  init(port: Int) {
    let list = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(string: "http://127.0.0.1:\(port)/json/list")!)) as! [[String: Any]]
    let page = list.first { ($0["url"] as? String ?? "").contains("parity") && ($0["type"] as? String) == "page" }!
    task = URLSession.shared.webSocketTask(with: URL(string: page["webSocketDebuggerUrl"] as! String)!)
    task.maximumMessageSize = 64 << 20
    task.resume()
  }
  func eval(_ expr: String) -> Any? {
    let id = nextId; nextId += 1
    let msg: [String: Any] = ["id": id, "method": "Runtime.evaluate", "params": ["expression": expr, "returnByValue": true, "awaitPromise": true]]
    let data = try! JSONSerialization.data(withJSONObject: msg)
    let sem = DispatchSemaphore(value: 0)
    task.send(.string(String(data: data, encoding: .utf8)!)) { _ in sem.signal() }; sem.wait()
    while true {
      var result: Any?; var done = false
      task.receive { r in
        if case .success(let m) = r, case .string(let s) = m, let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], (obj["id"] as? Int) == id {
          let res = (obj["result"] as? [String: Any])?["result"] as? [String: Any]
          if let ex = (obj["result"] as? [String: Any])?["exceptionDetails"] { print("CDP exception: \(ex)") }
          result = res?["value"]; done = true
        }
        sem.signal()
      }
      sem.wait(); if done { return result }
    }
  }
}

final class ChromeTarget: Target {
  let cdp = CDP(port: 9333)
  let app: NSRunningApplication
  var pid: pid_t { app.processIdentifier }
  init() {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep"); p.arguments = ["-f", "user-data-dir=/tmp/parity-chrome"]
    let o = Pipe(); p.standardOutput = o; try! p.run(); p.waitUntilExit()
    let pids = (String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "").split(separator: "\n").compactMap { Int32($0) }
    app = pids.compactMap { NSRunningApplication(processIdentifier: $0) }.first { $0.bundleIdentifier == "com.google.Chrome" }!
  }
  func js(_ e: String) -> Any? { cdp.eval(e) }
  func activate() { app.activate(options: []); usleep(350000); _ = js("__parity.focus()") }
  func reset(_ doc: String) {
    let lit = String(data: try! JSONSerialization.data(withJSONObject: [TITLE + doc]), encoding: .utf8)!
    _ = js("__parity.reset(\(lit)[0])"); activate()
  }
  func axText() -> String { js("__parity.axText()") as? String ?? "" }
  func selection() -> (Int, Int) { let a = js("__parity.axSelection()") as? [Int] ?? [-1, 0]; return (a[0], a[1]) }
  func setSelection(_ loc: Int, _ len: Int) { _ = js("__parity.setAxSelection(\(loc), \(len))"); usleep(150000) }
  func lineView() -> String { js("__parity.lineView()") as? String ?? "?" }
  func raw() -> String { js("__parity.raw()") as? String ?? "" }
  func caretRect() -> CGRect { let a = js("__parity.caretRect()") as? [Double] ?? [0, 0, 0, 0]; return CGRect(x: a[0], y: a[1], width: a[2], height: a[3]) }
}

// ---------- scenario execution ----------
struct StepState: Codable { let step: String; let line: String; let lineNo: Int }
struct Result: Codable { let id: String; let target: String; let states: [StepState]; let raw: String }

/// Caret placement in AX coordinates: `needle@off` finds needle after the title line.
func place(_ t: Target, _ spec: String) {
  let parts = spec.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
  let needle = String(parts[0]); let off = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
  let s = t.axText() as NSString; let after = s.range(of: "\n").location + 1
  if needle == "$" { t.setSelection(s.length, 0); return }
  let r = s.range(of: needle, options: [], range: NSRange(location: after, length: s.length - after))
  if r.location == NSNotFound { print("  ?? needle not found: \(needle)"); return }
  t.setSelection(r.location + off, 0)
}

func snapshot(_ t: Target, _ step: String) -> StepState {
  usleep(150000)
  let ax = t.axText() as NSString; let p = max(0, min(t.selection().0, ax.length))
  let lineNo = ax.substring(to: p).components(separatedBy: "\n").count - 2 // 0 = first line after the title
  return StepState(step: step, line: t.lineView(), lineNo: lineNo)
}

func run(_ t: Target, _ name: String, _ sc: [String: Any]) -> Result {
  let doc = sc["doc"] as! String
  t.reset(doc)
  if let at = sc["at"] as? String { place(t, at) }
  var states = [snapshot(t, "start")]
  for step in sc["steps"] as? [String] ?? [] {
    if step.hasPrefix("type:") { postText(t.pid, String(step.dropFirst(5))) }
    else if step.hasPrefix("key:") {
      let parts = step.dropFirst(4).split(separator: "+"); let k = String(parts[0])
      guard let code = KEYS[k] else { print("  unknown key \(k)"); continue }
      postKey(t.pid, code, flags(Array(parts.dropFirst())))
    }
    else if step.hasPrefix("at:") { place(t, String(step.dropFirst(3))) }
    else if step.hasPrefix("clip:") { setClipboard(String(step.dropFirst(5)).replacingOccurrences(of: "\\n", with: "\n")) ; continue }
    else if step.hasPrefix("wait:") { usleep(UInt32(Int(step.dropFirst(5)) ?? 0) * 1000) }
    else if step.hasPrefix("click:") {
      // click:<axIndex offset from needle>  — click at the left edge + dx of the char at needle@off
      continue
    }
    states.append(snapshot(t, step))
  }
  var raw = t.raw(); if raw.hasPrefix(TITLE) { raw = String(raw.dropFirst(TITLE.count)) }
  return Result(id: sc["id"] as! String, target: name, states: states, raw: raw)
}

let scenarios = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: scenarioPath))) as! [[String: Any]]
var results: [Result] = []
let bear: BearTarget? = (mode == "both" || mode == "bear") ? BearTarget() : nil
let chrome: ChromeTarget? = (mode == "both" || mode == "chrome") ? ChromeTarget() : nil
for sc in scenarios {
  let id = sc["id"] as! String
  if !filter.isEmpty && !id.contains(filter) { continue }
  print("▶ \(id)")
  if let b = bear { results.append(run(b, "bear", sc)) }
  if let c = chrome { results.append(run(c, "ours", sc)) }
  let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
  try! enc.encode(results).write(to: URL(fileURLWithPath: outPath))
}
print("DONE \(results.count) runs → \(outPath)")
