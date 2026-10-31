import Foundation

/// What a release changes, for the significant-change rule in each repo's
/// Definition of Done. One release can set several.
public struct ReleaseChange: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    /// Changes the type or category of personal data collected, stored or shared.
    public static let addsDataCategories = ReleaseChange(rawValue: 1 << 0)
    /// Adds in-app purchases (Utah and Alabama: where none existed).
    public static let addsInAppPurchases = ReleaseChange(rawValue: 1 << 1)
    /// Adds ads (Utah and Alabama: where none existed).
    public static let addsAds = ReleaseChange(rawValue: 1 << 2)
    /// Changes the age rating or the content descriptors behind it.
    public static let changesAgeRating = ReleaseChange(rawValue: 1 << 3)
    /// Materially changes functionality or user experience (Texas and
    /// Louisiana only).
    public static let materiallyChangesFunctionality = ReleaseChange(rawValue: 1 << 4)
}

/// States with a developer "significant change" duty. California's AB 1043
/// has none, so it is not listed.
public enum SignificantChangeState: String, Sendable, CaseIterable, Hashable {
    case texas
    case utah
    case louisiana
    case alabama
}

/// What the app should show a person when a significant change ships.
public enum SignificantUpdateAction: Sendable, Equatable {
    /// Nothing; no rule applies to this person (or the OS cannot say).
    case none
    /// Ask a parent through PermissionKit's `SignificantAppUpdateTopic`.
    case askParent
    /// Show Apple's adult acknowledgment sheet.
    case notifyAdult
}

public enum SignificantChange {
    /// The states in which `change` is a significant change. Empty means no
    /// store notification is owed.
    public static func states(for change: ReleaseChange) -> Set<SignificantChangeState> {
        var states: Set<SignificantChangeState> = []
        let narrow: ReleaseChange = [.addsDataCategories, .addsInAppPurchases, .addsAds, .changesAgeRating]
        if !change.isDisjoint(with: narrow) {
            states.formUnion(SignificantChangeState.allCases)
        }
        if change.contains(.materiallyChangesFunctionality) {
            states.formUnion([.texas, .louisiana])
        }
        return states
    }

    /// Which in-app flow a significant change calls for, from the
    /// platform's per-person requirements. Parental consent wins over adult
    /// notification; an empty set (including an OS too old to say) means none.
    public static func action(for requirements: Set<RegulatoryRequirement>) -> SignificantUpdateAction {
        if requirements.contains(.significantChangeRequiresParentalConsent) { return .askParent }
        if requirements.contains(.significantChangeRequiresAdultNotification) { return .notifyAdult }
        return .none
    }

    /// Whether the App Store age rating changed since the last launch, from
    /// `AppStore.ageRatingCode` (iOS 26.2+), which the app reads itself so this
    /// package never links the store framework. A missing previous value (first
    /// launch) or a missing current value is not a change.
    public static func ageRatingChanged(previous: Int?, current: Int?) -> Bool {
        guard let previous, let current else { return false }
        return previous != current
    }
}
