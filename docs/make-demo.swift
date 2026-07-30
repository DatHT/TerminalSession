// Generates docs/demo.gif — an illustrated walkthrough of the search panel:
// folder list → filter → expand a multi-terminal folder → pick the exact one.
// Pure AppKit drawing + ImageIO GIF encoding, no dependencies.
//
//   swift docs/make-demo.swift
//
// Replace with a real screen recording any time (see docs/record-demo.sh).

import AppKit
import UniformTypeIdentifiers

let W = 860, H = 470
let scale = 2

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
}
// palette (charcoal + amber)
let cBG = rgb(18, 21, 28)
let cPanel = rgb(24, 28, 37)
let cField = rgb(32, 37, 47)
let cSel = rgb(45, 51, 65)
let cAccent = rgb(233, 169, 76)
let cTitle = rgb(230, 233, 239)
let cSub = rgb(140, 149, 165)
let cDim = rgb(110, 119, 135)

struct Row { var title: String; var subtitle: String; var badge: String; var accent: Bool; var selected: Bool }
struct Spec { var query: String; var placeholder: String; var caret: Bool; var rows: [Row]; var hint: String }

func text(_ s: String, _ x: CGFloat, _ topY: CGFloat, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular, rightAlignX: CGFloat? = nil) {
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: color,
    ]
    let str = NSAttributedString(string: s, attributes: attrs)
    var x0 = x
    if let rx = rightAlignX { x0 = rx - str.size().width }
    // context is bottom-left origin; convert a top-based y to a draw point
    str.draw(at: NSPoint(x: x0, y: CGFloat(H) - topY - size - 3))
}

func roundedRect(_ x: CGFloat, _ topY: CGFloat, _ w: CGFloat, _ h: CGFloat, radius: CGFloat, fill: NSColor) {
    let rect = NSRect(x: x, y: CGFloat(H) - topY - h, width: w, height: h)
    let p = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    fill.setFill(); p.fill()
}

func drawFrame(_ spec: Spec) -> CGImage {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W * scale, pixelsHigh: H * scale,
                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    cBG.setFill(); NSBezierPath(rect: NSRect(x: 0, y: 0, width: W, height: H)).fill()

    // panel
    let px: CGFloat = 24, pw = CGFloat(W) - 48
    roundedRect(px, 24, pw, CGFloat(H) - 48, radius: 16, fill: cPanel)

    // search field
    let fx = px + 18, fw = pw - 36
    roundedRect(fx, 46, fw, 40, radius: 9, fill: cField)
    text("⌕", fx + 14, 56, size: 16, color: cDim)
    if spec.query.isEmpty {
        text(spec.placeholder, fx + 40, 55, size: 14, color: cDim)
    } else {
        text(spec.query, fx + 40, 55, size: 15, color: cTitle, weight: .medium)
        if spec.caret {
            let cx = fx + 40 + NSAttributedString(string: spec.query, attributes: [.font: NSFont.systemFont(ofSize: 15, weight: .medium)]).size().width + 2
            roundedRect(cx, 52, 2, 20, radius: 1, fill: cAccent)
        }
    }

    // rows
    var y: CGFloat = 104
    let rowH: CGFloat = 62
    for r in spec.rows {
        if r.selected {
            roundedRect(fx, y, fw, rowH - 6, radius: 8, fill: cSel)
            roundedRect(fx, y, 3, rowH - 6, radius: 1.5, fill: cAccent)
        }
        text(r.title, fx + 18, y + 11, size: 15, color: cTitle, weight: .semibold)
        if !r.badge.isEmpty {
            text(r.badge, 0, y + 13, size: 11.5, color: r.accent ? cAccent : cDim,
                 weight: r.accent ? .medium : .regular, rightAlignX: fx + fw - 16)
        }
        text(r.subtitle, fx + 18, y + 33, size: 12, color: cSub)
        y += rowH
    }

    // hint bar
    text(spec.hint, fx + 4, CGFloat(H) - 60, size: 11, color: cDim)

    NSGraphicsContext.restoreGraphicsState()
    return rep.cgImage!
}

// ---- the story ----
let foldersHint = "↑↓ move      ↵ open · ⟶ expand      esc close"
let termsHint = "↑↓ move      ↵ focus      ⟵ / esc back"

let frames: [(Spec, Double)] = [
    (Spec(query: "", placeholder: "Search folders with a terminal…", caret: false, rows: [
        Row(title: "terminalManagement", subtitle: "~/Documents/learning/claude/terminalManagement", badge: "2 terminals ›", accent: true, selected: true),
        Row(title: "prompt", subtitle: "~/Documents/learning/claude/prompt", badge: "claude", accent: false, selected: false),
        Row(title: "babytrack", subtitle: "~/Documents/learning/claude/babytrack", badge: "claude", accent: false, selected: false),
        Row(title: "VoiceLog", subtitle: "~/Documents/VoiceLog", badge: "claude", accent: false, selected: false),
    ], hint: foldersHint), 1.9),

    (Spec(query: "term", placeholder: "", caret: true, rows: [
        Row(title: "terminalManagement", subtitle: "~/Documents/learning/claude/terminalManagement", badge: "2 terminals ›", accent: true, selected: true),
    ], hint: foldersHint), 1.5),

    (Spec(query: "term", placeholder: "", caret: false, rows: [
        Row(title: "‹ terminalManagement", subtitle: "expanded — pick a terminal", badge: "", accent: false, selected: false),
        Row(title: "claude", subtitle: "Terminal · ttys014", badge: "", accent: false, selected: true),
        Row(title: "shell", subtitle: "Terminal · ttys001", badge: "", accent: false, selected: false),
    ], hint: termsHint), 1.6),

    (Spec(query: "", placeholder: "‹ terminalManagement — pick a terminal", caret: false, rows: [
        Row(title: "‹ terminalManagement", subtitle: "expanded — pick a terminal", badge: "", accent: false, selected: false),
        Row(title: "claude", subtitle: "Terminal · ttys014", badge: "", accent: false, selected: false),
        Row(title: "shell", subtitle: "Terminal · ttys001", badge: "↵ jump", accent: true, selected: true),
    ], hint: termsHint), 1.9),
]

let images = frames.map { drawFrame($0.0) }
let outDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("docs")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let gifURL = outDir.appendingPathComponent("demo.gif")

let dest = CGImageDestinationCreateWithURL(gifURL as CFURL, UTType.gif.identifier as CFString, images.count, nil)!
CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for (i, img) in images.enumerated() {
    CGImageDestinationAddImage(dest, img, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: frames[i].1]] as CFDictionary)
}
CGImageDestinationFinalize(dest)
print("wrote \(gifURL.path)")

// also dump the first frame as PNG for quick visual review
let pngRep = NSBitmapImageRep(cgImage: images[0])
if let png = pngRep.representation(using: .png, properties: [:]) {
    try? png.write(to: outDir.appendingPathComponent("demo_frame1.png"))
}
