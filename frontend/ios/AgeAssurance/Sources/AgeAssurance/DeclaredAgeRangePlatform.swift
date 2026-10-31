// The live adapter over Apple's Declared Age Range and PermissionKit APIs.
// It deliberately links no store or network framework, so apps whose source
// guards forbid those can vendor it unchanged. Compiled only where UIKit and the frameworks exist (the iOS
// 26 SDK); on macOS `swift test` this file is empty and the fakes in the
// tests stand in. Every call sits behind `#available`, so the iOS 17-26.1
// population simply reports `isSupported == false`, which the evaluator turns
// into `.unavailable(.platformUnsupported)`, never into an adult.
//
// The app target must carry the `com.apple.developer.declared-age-range`
// entitlement (Signing & Capabilities > Declared Age Range).

#if canImport(UIKit) && canImport(DeclaredAgeRange)
import DeclaredAgeRange
import UIKit
#if canImport(PermissionKit)
import PermissionKit
#endif

public struct DeclaredAgeRangePlatform: AgeRangePlatform {
    /// Supplies the view controller Apple presents its sharing sheet from.
    public typealias PresenterProvider = @MainActor @Sendable () -> UIViewController?

    private let presenter: PresenterProvider

    public init(presenter: @escaping PresenterProvider = { DeclaredAgeRangePlatform.topViewController() }) {
        self.presenter = presenter
    }

    public var isSupported: Bool {
        if #available(iOS 26.2, *) { return true }
        return false
    }

    public func isEligibleForAgeFeatures() async throws -> Bool {
        if #available(iOS 26.2, *) {
            return try await AgeRangeService.shared.isEligibleForAgeFeatures
        }
        return false
    }

    public func requiredRegulatoryFeatures() async throws -> Set<RegulatoryRequirement>? {
        if #available(iOS 26.4, *) {
            let features = try await AgeRangeService.shared.requiredRegulatoryFeatures
            var mapped: Set<RegulatoryRequirement> = []
            for feature in features {
                switch feature {
                case .declaredAgeRangeRequired:
                    mapped.insert(.declaredAgeRangeRequired)
                case .significantAppChangeRequiresAdultNotification:
                    mapped.insert(.significantChangeRequiresAdultNotification)
                case .significantAppChangeRequiresParentalConsent:
                    mapped.insert(.significantChangeRequiresParentalConsent)
                @unknown default:
                    break
                }
            }
            return mapped
        }
        return nil
    }

    @MainActor
    public func requestAgeRange() async throws -> AgeRangeResponse {
        guard #available(iOS 26.2, *) else { throw AgeAssuranceError.platformUnsupported }
        guard let viewController = presenter() else { throw AgeAssuranceError.noPresenter }
        let gates = AgeAssurance.ageGates
        let response = try await AgeRangeService.shared.requestAgeRange(
            ageGates: gates.0, gates.1, gates.2, in: viewController
        )
        switch response {
        case .declinedSharing:
            return .declinedSharing
        case let .sharing(range):
            return .sharing(
                lowerBound: range.lowerBound,
                upperBound: range.upperBound,
                declaration: Self.declaration(range.ageRangeDeclaration)
            )
        @unknown default:
            return .declinedSharing
        }
    }

    @available(iOS 26.2, *)
    static func declaration(_ value: AgeRangeService.AgeRangeDeclaration?) -> AgeDeclaration {
        guard let value else { return .unspecified }
        switch value {
        case .selfDeclared: return .selfDeclared
        case .guardianDeclared: return .guardianDeclared
        default: return .confirmed
        }
    }

    /// The frontmost view controller of the foreground scene.
    @MainActor
    public static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var top = scene?.keyWindow?.rootViewController ?? scene?.windows.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

public enum AgeAssuranceError: Error, Sendable {
    case platformUnsupported
    case noPresenter
}

/// Presents the significant-change flow the platform requires for this
/// person. Call it on the first launch of a release that the Definition of
/// Done marks as a significant change. A no-op on older systems.
public enum SignificantUpdatePresenter {
    @MainActor
    public static func present(
        updateDescription: String,
        requirements: Set<RegulatoryRequirement>,
        from viewController: UIViewController
    ) async throws {
        switch SignificantChange.action(for: requirements) {
        case .none:
            return
        case .askParent:
            #if canImport(PermissionKit)
            if #available(iOS 26.2, *) {
                let question = PermissionQuestion(
                    significantAppUpdateTopic: SignificantAppUpdateTopic(description: updateDescription)
                )
                try await AskCenter.shared.ask(question, in: viewController)
            }
            #endif
        case .notifyAdult:
            if #available(iOS 26.4, *), let scene = viewController.view.window?.windowScene {
                try await AgeRangeService.shared.showSignificantUpdateAcknowledgment(
                    in: scene, updateDescription: updateDescription
                )
            }
        }
    }
}
#endif
