import UIKit
import StoreKit
import Capacitor
import AgeAssurance

/// App-store age assurance (Texas SB 2420, California AB 1043, Alabama
/// HB 161, Utah 13-76, Louisiana R.S. 51:1771).
///
/// A thin bridge over the shared AgeAssurance package (frontend/ios/AgeAssurance,
/// vendored from ca-fish-planting-alerts). `requestAgeRange` asks Apple's
/// Declared Age Range for this person's age range, once per launch, and
/// hands the web layer the bracket or the reason there is none. The web layer
/// (services/nativeAgeRange.ts) keeps it in memory only and decides with it
/// (config/ageAssurance.ts). Before iOS 26.2 the answer is always
/// `unavailable`, never an adult.
///
/// `appTransaction` returns Apple's signed app transaction, which the web
/// layer registers with the server only for a person Apple reports as a
/// minor, so a parent's RESCIND_CONSENT notification can reach the account.
///
/// It lives in the app target, like NativeReviewPlugin, and
/// MainViewController registers it.
@objc(NativeAgeRangePlugin)
public class NativeAgeRangePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAgeRangePlugin"
    public let jsName = "NativeAgeRange"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAgeRange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appTransaction", returnType: CAPPluginReturnPromise),
    ]

    @MainActor private var session: AgeAssuranceSession?

    @objc func requestAgeRange(_ call: CAPPluginCall) {
        let policy = AgeRangeRequestPolicy(rawValue: call.getString("requestPolicy") ?? "")
            ?? AgeAssuranceConfiguration.recommended.requestPolicy
        Task { @MainActor [weak self] in
            guard let self else { return }
            let session = self.session ?? AgeAssuranceSession(
                configuration: AgeAssuranceConfiguration(requestPolicy: policy),
                platform: self.platform()
            )
            self.session = session
            let result = await session.requestOnLaunch()
            call.resolve(Self.payload(result))
        }
    }

    @objc func appTransaction(_ call: CAPPluginCall) {
        Task {
            if #available(iOS 16.0, *) {
                if let shared = try? await AppTransaction.shared {
                    call.resolve(["signedAppTransaction": shared.jwsRepresentation])
                    return
                }
            }
            call.resolve([:])
        }
    }

    @MainActor
    private func platform() -> AgeRangePlatform {
        #if canImport(DeclaredAgeRange)
        return DeclaredAgeRangePlatform(presenter: { [weak self] in
            self?.bridge?.viewController ?? DeclaredAgeRangePlatform.topViewController()
        })
        #else
        return UnsupportedAgeRangePlatform()
        #endif
    }

    /// The shape services/nativeAgeRange.ts parses (lib/ageSignal.ts).
    static func payload(_ result: AgeAssuranceResult) -> [String: Any] {
        let requirements = result.requirements.map(\.rawValue).sorted()
        switch result.signal {
        case let .known(bracket, declaration):
            return [
                "status": "known",
                "bracket": bracket.rawValue,
                "declaration": declaration.rawValue,
                "requirements": requirements,
            ]
        case let .unavailable(reason):
            return [
                "status": "unavailable",
                "reason": Self.reasonName(reason),
                "requirements": requirements,
            ]
        }
    }

    static func reasonName(_ reason: AgeSignalUnavailableReason) -> String {
        switch reason {
        case .notYetRequested: return "notYetRequested"
        case .platformUnsupported: return "platformUnsupported"
        case .notInScope: return "notInScope"
        case .declinedSharing: return "declinedSharing"
        case .requestFailed: return "requestFailed"
        case .unrecognizedRange: return "unrecognizedRange"
        }
    }
}
