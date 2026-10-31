import Foundation

/// When the app asks the platform for an age range. This is the one value
/// each app sets (decision D in the 2026-10-30 compliance report).
public enum AgeRangeRequestPolicy: String, Sendable, Equatable {
    /// Ask only when the platform says the person is in scope
    /// (`isEligibleForAgeFeatures`, or `declaredAgeRangeRequired` in
    /// `requiredRegulatoryFeatures`). Never shows a sharing prompt to people
    /// no law covers. Recommended (D1).
    case onlyWhenRequired
    /// Ask on every launch for everyone on a supported OS (D2).
    case always
}

/// Per-app configuration. Apps keep exactly one instance of this, in one
/// file, so a decision can change without code rework.
public struct AgeAssuranceConfiguration: Sendable, Equatable {
    public var requestPolicy: AgeRangeRequestPolicy

    public init(requestPolicy: AgeRangeRequestPolicy) {
        self.requestPolicy = requestPolicy
    }

    /// The report's recommended options.
    public static let recommended = AgeAssuranceConfiguration(requestPolicy: .onlyWhenRequired)
}

/// Jurisdiction rules the platform says apply to the signed-in person
/// (Apple's `RegulatoryFeature`, iOS 26.4+). The app never learns the state.
public enum RegulatoryRequirement: String, Sendable, Hashable, CaseIterable {
    case declaredAgeRangeRequired
    case significantChangeRequiresAdultNotification
    case significantChangeRequiresParentalConsent
}

/// The platform's raw answer to an age-range request.
public enum AgeRangeResponse: Sendable, Equatable {
    case declinedSharing
    case sharing(lowerBound: Int?, upperBound: Int?, declaration: AgeDeclaration)
}

/// The seam between the pure logic and Apple's frameworks. The live adapter
/// is `DeclaredAgeRangePlatform`; tests use fakes.
public protocol AgeRangePlatform: Sendable {
    /// False before iOS 26.2 or when the framework is missing.
    var isSupported: Bool { get }
    /// `AgeRangeService.isEligibleForAgeFeatures` (iOS 26.2+).
    func isEligibleForAgeFeatures() async throws -> Bool
    /// `AgeRangeService.requiredRegulatoryFeatures`; nil before iOS 26.4.
    func requiredRegulatoryFeatures() async throws -> Set<RegulatoryRequirement>?
    /// `AgeRangeService.requestAgeRange(ageGates: 13, 16, 18, in:)`.
    @MainActor func requestAgeRange() async throws -> AgeRangeResponse
}

/// The outcome of one launch-time check.
public struct AgeAssuranceResult: Sendable, Equatable {
    public var signal: AgeSignal
    /// Empty when unknown (older OS) or when no rule applies.
    public var requirements: Set<RegulatoryRequirement>

    public init(signal: AgeSignal, requirements: Set<RegulatoryRequirement> = []) {
        self.signal = signal
        self.requirements = requirements
    }

    public static let notYetRequested = AgeAssuranceResult(signal: .unavailable(.notYetRequested))
}

public enum AgeAssuranceEvaluator {
    /// Runs the launch-time check: decide whether to ask, ask, and map the
    /// answer. Never throws; every failure becomes an `.unavailable` signal.
    @MainActor
    public static func evaluate(
        platform: AgeRangePlatform,
        configuration: AgeAssuranceConfiguration
    ) async -> AgeAssuranceResult {
        guard platform.isSupported else {
            return AgeAssuranceResult(signal: .unavailable(.platformUnsupported))
        }

        var requirements: Set<RegulatoryRequirement> = []
        var inScope: Bool
        do {
            let eligible = try await platform.isEligibleForAgeFeatures()
            requirements = try await platform.requiredRegulatoryFeatures() ?? []
            inScope = eligible || requirements.contains(.declaredAgeRangeRequired)
        } catch {
            // Scope unknown: fail toward the legal duty and ask. In regulated
            // regions the system answers without a prompt anyway.
            inScope = true
        }

        if configuration.requestPolicy == .onlyWhenRequired && !inScope {
            return AgeAssuranceResult(signal: .unavailable(.notInScope), requirements: requirements)
        }

        let signal: AgeSignal
        do {
            switch try await platform.requestAgeRange() {
            case .declinedSharing:
                signal = .unavailable(.declinedSharing)
            case let .sharing(lower, upper, declaration):
                signal = .from(lowerBound: lower, upperBound: upper, declaration: declaration)
            }
        } catch {
            signal = .unavailable(.requestFailed)
        }
        return AgeAssuranceResult(signal: signal, requirements: requirements)
    }
}

/// A platform with no age-range support: SwiftUI previews, macOS test hosts,
/// or any build without the iOS 26 SDK. Always yields `.platformUnsupported`.
public struct UnsupportedAgeRangePlatform: AgeRangePlatform {
    public init() {}
    public var isSupported: Bool { false }
    public func isEligibleForAgeFeatures() async throws -> Bool { false }
    public func requiredRegulatoryFeatures() async throws -> Set<RegulatoryRequirement>? { nil }
    @MainActor public func requestAgeRange() async throws -> AgeRangeResponse { .declinedSharing }
}
