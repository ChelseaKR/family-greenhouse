import Foundation

// Native alerts and action sheets for the web (NativeChrome's `present`), the
// part that decides, in plain Swift with no UIKit, so it compiles and runs on
// its own with `swiftc` (see docs/mobile.md, "Alerts and action sheets").
//
// The one rule this file exists to keep: a confirmation is reported ONLY when
// the person tapped a button that is not the cancel button. Every other way
// an alert or a sheet can end (Cancel, a tap outside it, a swipe, the app
// going to the background, the web closing it, another one replacing it, or
// the controller simply going away) reports "no choice" (nil), and nothing
// can report twice.

enum PresentKind: String {
    /// A centered alert: a confirmation.
    case alert
    /// An action sheet: a choice of several things to do.
    case actionSheet
}

enum PresentActionStyle: String {
    case `default`
    /// Drawn in red: the button that removes or ends something.
    case destructive
    /// The way out. Exactly one per request; it never reports its id.
    case cancel
}

struct PresentAction: Equatable {
    let id: String
    let title: String
    let style: PresentActionStyle
}

struct PresentRequest: Equatable {
    let kind: PresentKind
    let title: String?
    let message: String?
    let actions: [PresentAction]

    /// More than this is not a choice anyone should face in a sheet.
    static let maxActions = 10

    /// Reads a request as the plugin receives it. Returns the request, or why
    /// it was refused; a refused request is never shown.
    static func parse(kind: String?, title: String?, message: String?, actions raw: [[String: Any]]?)
        -> (request: PresentRequest?, error: String?) {
        guard let kind = kind.flatMap(PresentKind.init(rawValue:)) else {
            return (nil, "kind must be alert or actionSheet")
        }
        let title = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasTitle = !(title ?? "").isEmpty
        let hasMessage = !(message ?? "").isEmpty
        if kind == .alert && !hasTitle && !hasMessage {
            return (nil, "an alert needs a title or a message")
        }
        guard let raw = raw, !raw.isEmpty, raw.count <= maxActions else {
            return (nil, "between 2 and \(maxActions) actions")
        }
        var actions: [PresentAction] = []
        var ids = Set<String>()
        for item in raw {
            guard let id = item["id"] as? String, !id.isEmpty,
                  let title = item["title"] as? String,
                  !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let style = (item["style"] as? String).flatMap(PresentActionStyle.init(rawValue:))
            else { return (nil, "every action needs an id, a title and a style") }
            guard ids.insert(id).inserted else { return (nil, "action ids must be unique") }
            actions.append(PresentAction(id: id, title: title, style: style))
        }
        // UIKit allows one cancel action and crashes on a second. Requiring
        // exactly one also means there is always a way out that confirms
        // nothing.
        guard actions.filter({ $0.style == .cancel }).count == 1 else {
            return (nil, "exactly one cancel action")
        }
        guard actions.contains(where: { $0.style != .cancel }) else {
            return (nil, "at least one action besides cancel")
        }
        return (PresentRequest(kind: kind, title: hasTitle ? title : nil,
                               message: hasMessage ? message : nil, actions: actions), nil)
    }
}

/// How one alert or sheet ended. Answers exactly once.
final class PresentOutcome {
    private(set) var answered = false
    private let completion: (String?) -> Void

    /// `completion` receives the chosen action's id, or nil for no choice.
    init(completion: @escaping (String?) -> Void) {
        self.completion = completion
    }

    /// A button was tapped. The cancel button reports no choice.
    func chose(_ action: PresentAction) {
        finish(action.style == .cancel ? nil : action.id)
    }

    /// It ended any other way: dismissed, backgrounded, replaced, closed by
    /// the web. Never a choice.
    func cancel() {
        finish(nil)
    }

    private func finish(_ id: String?) {
        guard !answered else { return }
        answered = true
        completion(id)
    }

    /// The alert, and with it the only references to this object (its
    /// buttons' handlers), went away without an answer: a way of ending it
    /// nobody thought of still ends as no choice, never as a hanging promise.
    deinit {
        if !answered { completion(nil) }
    }
}
