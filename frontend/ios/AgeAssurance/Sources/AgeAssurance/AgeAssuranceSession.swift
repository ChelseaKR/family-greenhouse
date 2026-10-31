import Combine
import Foundation

/// Holds this launch's age signal in memory. Nothing here is written to
/// disk, sent over the network, logged or shown to analytics: the laws and
/// Apple's license agreement allow the signal to be used only to comply.
@MainActor
public final class AgeAssuranceSession: ObservableObject {
    @Published public private(set) var result: AgeAssuranceResult = .notYetRequested

    public let configuration: AgeAssuranceConfiguration
    private let platform: AgeRangePlatform
    private var inFlight: Task<AgeAssuranceResult, Never>?
    private var hasRequested = false

    public init(configuration: AgeAssuranceConfiguration, platform: AgeRangePlatform) {
        self.configuration = configuration
        self.platform = platform
    }

    public var signal: AgeSignal { result.signal }

    /// Request once per launch ("when the application is downloaded and
    /// launched"). Later calls return the held result; concurrent callers
    /// share one request.
    @discardableResult
    public func requestOnLaunch() async -> AgeAssuranceResult {
        if hasRequested { return result }
        if let inFlight { return await inFlight.value }
        let platform = self.platform
        let configuration = self.configuration
        let task = Task { @MainActor in
            await AgeAssuranceEvaluator.evaluate(platform: platform, configuration: configuration)
        }
        inFlight = task
        let value = await task.value
        result = value
        hasRequested = true
        inFlight = nil
        return value
    }
}
