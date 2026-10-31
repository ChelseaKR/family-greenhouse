import Foundation

/// Namespace and version of the vendored package. Bump `version` whenever the
/// canonical copy changes, so a stale vendored copy is visible in a diff.
public enum AgeAssurance {
    public static let version = "1.0.0"

    /// The age gates every app requests. They produce the four brackets the
    /// state laws use (under 13, 13-15, 16-17, 18 and over).
    public static let ageGates: (Int, Int, Int) = (13, 16, 18)
}

/// The four age categories shared by Texas SB 2420, Utah 13-76, Louisiana
/// R.S. 51:1771, Alabama HB 161 and California Civ. Code 1798.501.
public enum AgeBracket: String, Sendable, CaseIterable, Equatable {
    case under13
    case age13to15
    case age16to17
    case adult

    public var isMinor: Bool { self != .adult }
}

/// Who stood behind the declared range, as Apple or Google reports it.
public enum AgeDeclaration: String, Sendable, Equatable {
    case selfDeclared
    case guardianDeclared
    /// Checked by the platform (ID, payment card, Apple's `confirmed`, or
    /// Google's TIER_C / TIER_D sources).
    case confirmed
    /// The platform shared a range without saying how it was declared.
    case unspecified
}

/// Why no age bracket is known. Every one of these means "unknown", never
/// "adult": absence is not a value.
public enum AgeSignalUnavailableReason: Sendable, Equatable {
    /// The app has not asked yet this session.
    case notYetRequested
    /// The OS has no Declared Age Range support (before iOS 26.2), or the
    /// framework is missing from this build.
    case platformUnsupported
    /// The platform says age assurance does not apply to this person, and the
    /// app's policy is to request only when required.
    case notInScope
    /// The person (or their guardian) chose not to share.
    case declinedSharing
    /// The platform call failed (network, sandbox, unknown error).
    case requestFailed
    /// A range came back that does not fit one bracket, for example a range
    /// that straddles a gate or has no bounds at all.
    case unrecognizedRange(lowerBound: Int?, upperBound: Int?)
}

/// The age signal as the app holds it, in memory, for one session.
public enum AgeSignal: Sendable, Equatable {
    case known(AgeBracket, AgeDeclaration)
    case unavailable(AgeSignalUnavailableReason)

    /// The bracket, or nil when no bracket is known.
    public var bracket: AgeBracket? {
        if case let .known(bracket, _) = self { return bracket }
        return nil
    }

    /// True only when the platform affirmatively reported 18 or over. A
    /// missing, declined, failed or ambiguous signal is never an adult.
    public var isKnownAdult: Bool { bracket == .adult }

    /// True only when the platform affirmatively reported a minor bracket.
    public var isKnownMinor: Bool { bracket?.isMinor ?? false }

    /// True only when the platform affirmatively reported under 13.
    public var isKnownUnder13: Bool { bracket == .under13 }

    /// Maps a platform range to a bracket. The gates are 13, 16 and 18, so a
    /// shared range is expected to be one of: (nil or 0...12, 12),
    /// (13, 15), (16, 17), (18, nil or more). Anything else is reported as
    /// unrecognized rather than guessed.
    public static func from(
        lowerBound: Int?,
        upperBound: Int?,
        declaration: AgeDeclaration
    ) -> AgeSignal {
        if let bracket = bracket(lowerBound: lowerBound, upperBound: upperBound) {
            return .known(bracket, declaration)
        }
        // negative-control: unrecognized-range (scripts/negative-control.sh rewrites this line)
        return .unavailable(.unrecognizedRange(lowerBound: lowerBound, upperBound: upperBound))
    }

    static func bracket(lowerBound: Int?, upperBound: Int?) -> AgeBracket? {
        let gates = AgeAssurance.ageGates
        let floor = lowerBound ?? 0
        switch (lowerBound, upperBound) {
        case (nil, nil):
            // No bounds at all is not "unbounded adult", it is no information.
            return nil
        case let (_, upper?) where upper < gates.0 && floor >= 0 && floor <= upper:
            return .under13
        case let (lower?, upper?) where lower >= gates.0 && upper < gates.1:
            return .age13to15
        case let (lower?, upper?) where lower >= gates.1 && upper < gates.2:
            return .age16to17
        case let (lower?, _) where lower >= gates.2:
            if let upper = upperBound, upper < lower { return nil }
            return .adult
        default:
            return nil
        }
    }
}
