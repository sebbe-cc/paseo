import ExpoModulesCore
import UIKit

public class PaseoTextSelectionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoTextSelection")
    View(PaseoTextSelectionView.self) {
      Events("onSelect")
      Prop("actions") { (view: PaseoTextSelectionView, actions: [[String: String]]) in
        view.actions = actions
        view.setNeedsLayout()
      }
    }
  }
}

final class PaseoTextSelectionView: ExpoView {
  let onSelect = EventDispatcher()
  var actions: [[String: String]] = []
  private var delegates: [ObjectIdentifier: SelectionDelegate] = [:]

  override func layoutSubviews() {
    super.layoutSubviews()
    guard !actions.isEmpty else {
      restoreDelegates()
      return
    }
    var retained = Set<ObjectIdentifier>()
    visit(self, path: "text", retained: &retained)
    for key in Array(delegates.keys) where !retained.contains(key) {
      delegates.removeValue(forKey: key)?.restore()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { restoreDelegates() } else { setNeedsLayout() }
  }

  private func restoreDelegates() {
    delegates.values.forEach { $0.restore() }
    delegates.removeAll()
  }

  private func visit(_ view: UIView, path: String, retained: inout Set<ObjectIdentifier>) {
    if view !== self, view is PaseoTextSelectionView { return }
    if let textView = view as? UITextView, textView.isSelectable, !textView.isEditable {
      let key = ObjectIdentifier(textView)
      retained.insert(key)
      let proxy = delegates[key] ?? SelectionDelegate(textView: textView, owner: self)
      proxy.surfaceId = path
      delegates[key] = proxy
      if textView.delegate !== proxy {
        proxy.original = textView.delegate
        textView.delegate = proxy
      }
      return
    }
    for (index, child) in view.subviews.enumerated() {
      visit(child, path: "\(path).\(index)", retained: &retained)
    }
  }
}

private final class SelectionDelegate: NSObject, UITextViewDelegate {
  weak var original: UITextViewDelegate?
  weak var textView: UITextView?
  weak var owner: PaseoTextSelectionView?
  var surfaceId = "text"

  init(textView: UITextView, owner: PaseoTextSelectionView) {
    self.textView = textView
    self.owner = owner
    self.original = textView.delegate
    super.init()
  }

  func restore() {
    if textView?.delegate === self { textView?.delegate = original }
  }

  override func responds(to selector: Selector!) -> Bool {
    super.responds(to: selector) || original?.responds(to: selector) == true
  }

  override func forwardingTarget(for selector: Selector!) -> Any? {
    if original?.responds(to: selector) == true { return original }
    return super.forwardingTarget(for: selector)
  }

  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange,
                suggestedActions: [UIMenuElement]) -> UIMenu? {
    let base = original?.textView?(textView, editMenuForTextIn: range,
                                  suggestedActions: suggestedActions)
    let text = (textView.text ?? "") as NSString
    guard let owner, range.length > 0, range.location != NSNotFound,
          NSMaxRange(range) <= text.length else { return base }
    let snapshot: [String: Any] = [
      "text": text.substring(with: range), "start": range.location,
      "end": NSMaxRange(range), "surfaceId": surfaceId,
      "prefix": text.substring(with: NSRange(location: max(0, range.location - 64),
                                            length: min(64, range.location))),
      "suffix": text.substring(with: NSRange(location: NSMaxRange(range),
                                            length: min(64, text.length - NSMaxRange(range))))
    ]
    let actions = owner.actions.compactMap { action -> UIAction? in
      guard let id = action["id"], let title = action["title"] else { return nil }
      return UIAction(title: title) { [weak owner] _ in
        guard let owner, owner.actions.contains(where: { $0["id"] == id }) else { return }
        owner.onSelect(snapshot.merging(["actionId": id]) { _, new in new })
      }
    }
    return UIMenu(children: (base?.children ?? suggestedActions) + actions)
  }
}
