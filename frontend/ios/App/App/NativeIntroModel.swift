import Foundation

// The signed-out intro (NativeIntro `present`): what the web asked for, and
// what the intro may answer. Plain Swift with no UIKit or SwiftUI, so it
// compiles and runs on its own with `swiftc` (NativeIntroView.swift draws it;
// NativeIntroPlugin.swift carries it over the bridge).
//
// The web owns every word, in the app's language (frontend/src/config/
// nativeIntro.ts, from the en and es catalogs); Swift owns the pictures, the
// paging and the motion. The intro never signs anyone in or up: it reports
// which of the two doors the person chose and the web opens that screen.

/// One page of the intro. `id` picks the illustration
/// (`household`, `claim`, `away`, `start`); an id Swift does not know gets
/// none, so a page the web adds later still shows its words.
struct IntroPage: Equatable {
    let id: String
    let title: String
    let body: String
}

/// Where the intro opens: the whole story (the first signed-out launch on
/// this install), or only the last page (after that, and after sign-out).
enum IntroStart: String {
    case story
    case final
}

/// The two doors on the last page. Anything else is no choice.
enum IntroChoice: String {
    case create
    case signIn
}

struct IntroRequest: Equatable {
    let start: IntroStart
    /// The story pages, then the last page; never empty.
    let pages: [IntroPage]
    let skip: String
    let next: String
    /// "Page {n} of {total}", for VoiceOver on the page indicator.
    let pagePosition: String
    /// The wordmark and tagline above the last page's title.
    let appName: String
    let tagline: String
    /// "Create account"; nil when registration is paused, and then the last
    /// page offers only the sign-in door.
    let create: String?
    /// "I already have an account".
    let signIn: String

    /// The same intro, opening at `start` instead.
    func starting(_ start: IntroStart) -> IntroRequest {
        IntroRequest(
            start: start, pages: pages, skip: skip, next: next, pagePosition: pagePosition,
            appName: appName, tagline: tagline, create: create, signIn: signIn
        )
    }

    /// The pages this presentation shows: all of them for the story, only
    /// the last for `final`.
    var shownPages: [IntroPage] {
        start == .final ? [pages[pages.count - 1]] : pages
    }

    /// Story pages get Skip, Next and the page indicator; the last page has
    /// the two doors instead.
    func isLast(_ index: Int) -> Bool {
        index >= shownPages.count - 1
    }

    func position(_ index: Int) -> String {
        pagePosition
            .replacingOccurrences(of: "{n}", with: String(index + 1))
            .replacingOccurrences(of: "{total}", with: String(shownPages.count))
    }

    /// Reads the bridge's options. Every word must be there: an intro with a
    /// blank button is refused, and the web keeps its own sign-in screen.
    static func parse(_ raw: [String: Any]) -> (request: IntroRequest?, error: String?) {
        guard let start = IntroStart(rawValue: raw["start"] as? String ?? "") else {
            return (nil, "start must be story or final")
        }
        let pages: [IntroPage] = (raw["pages"] as? [[String: Any]] ?? []).compactMap { page in
            guard let id = page["id"] as? String, !id.isEmpty,
                  let title = page["title"] as? String, !title.isEmpty else { return nil }
            return IntroPage(id: id, title: title, body: page["body"] as? String ?? "")
        }
        guard !pages.isEmpty else { return (nil, "an intro needs at least one page") }
        func word(_ key: String) -> String? {
            guard let value = raw[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        guard let signIn = word("signIn") else { return (nil, "signIn is required") }
        guard let skip = word("skip"), let next = word("next"),
              let pagePosition = word("pagePosition") else {
            return (nil, "skip, next and pagePosition are required")
        }
        return (
            IntroRequest(
                start: start,
                pages: pages,
                skip: skip,
                next: next,
                pagePosition: pagePosition,
                appName: word("appName") ?? "",
                tagline: word("tagline") ?? "",
                create: word("create"),
                signIn: signIn
            ),
            nil
        )
    }
}

/// How one intro ended. Answers exactly once: the door that was tapped, or
/// nil any other way (the web closed it, another one replaced it, VoiceOver's
/// escape on the last page). Create is a choice only when it was offered.
final class IntroSession {
    let request: IntroRequest
    private(set) var answered = false
    private let answer: (IntroChoice?) -> Void

    init(request: IntroRequest, answer: @escaping (IntroChoice?) -> Void) {
        self.request = request
        self.answer = answer
    }

    /// A door was tapped. Returns false when it is not one this intro offers
    /// or the intro has already answered.
    @discardableResult
    func choose(_ choice: IntroChoice) -> Bool {
        if choice == .create && request.create == nil { return false }
        return finish(choice)
    }

    /// Closed without a choice.
    func close() {
        finish(nil)
    }

    @discardableResult
    private func finish(_ choice: IntroChoice?) -> Bool {
        guard !answered else { return false }
        answered = true
        answer(choice)
        return true
    }
}
