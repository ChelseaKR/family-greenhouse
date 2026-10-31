import XCTest
@testable import AgeAssurance

/// A scripted stand-in for Apple's AgeRangeService.
final class FakePlatform: AgeRangePlatform, @unchecked Sendable {
    var isSupported = true
    var eligible: Result<Bool, Error> = .success(true)
    var features: Result<Set<RegulatoryRequirement>?, Error> = .success(nil)
    var response: Result<AgeRangeResponse, Error> = .success(.declinedSharing)
    private(set) var requestCount = 0

    func isEligibleForAgeFeatures() async throws -> Bool { try eligible.get() }
    func requiredRegulatoryFeatures() async throws -> Set<RegulatoryRequirement>? { try features.get() }
    @MainActor func requestAgeRange() async throws -> AgeRangeResponse {
        requestCount += 1
        return try response.get()
    }
}

struct FakeError: Error {}

@MainActor
final class AgeAssuranceEvaluatorTests: XCTestCase {
    private let recommended = AgeAssuranceConfiguration.recommended

    private func evaluate(_ platform: FakePlatform, _ config: AgeAssuranceConfiguration? = nil) async -> AgeAssuranceResult {
        await AgeAssuranceEvaluator.evaluate(platform: platform, configuration: config ?? recommended)
    }

    private func sharing(_ lower: Int?, _ upper: Int?, _ declaration: AgeDeclaration = .selfDeclared) -> FakePlatform {
        let platform = FakePlatform()
        platform.response = .success(.sharing(lowerBound: lower, upperBound: upper, declaration: declaration))
        return platform
    }

    // MARK: each bracket

    func testUnder13() async {
        let result = await evaluate(sharing(nil, 12, .guardianDeclared))
        XCTAssertEqual(result.signal, .known(.under13, .guardianDeclared))
        XCTAssertTrue(result.signal.isKnownUnder13)
        XCTAssertTrue(result.signal.isKnownMinor)
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testUnder13WithZeroLowerBound() async {
        let result = await evaluate(sharing(0, 12))
        XCTAssertEqual(result.signal.bracket, .under13)
    }

    func testThirteenToFifteen() async {
        let result = await evaluate(sharing(13, 15))
        XCTAssertEqual(result.signal, .known(.age13to15, .selfDeclared))
        XCTAssertTrue(result.signal.isKnownMinor)
        XCTAssertFalse(result.signal.isKnownUnder13)
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testSixteenToSeventeen() async {
        let result = await evaluate(sharing(16, 17, .confirmed))
        XCTAssertEqual(result.signal, .known(.age16to17, .confirmed))
        XCTAssertTrue(result.signal.isKnownMinor)
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testAdult() async {
        let result = await evaluate(sharing(18, nil, .confirmed))
        XCTAssertEqual(result.signal, .known(.adult, .confirmed))
        XCTAssertTrue(result.signal.isKnownAdult)
        XCTAssertFalse(result.signal.isKnownMinor)
    }

    // MARK: signal unavailable; never an adult

    func testOlderOSIsUnavailableNotAdult() async {
        let platform = FakePlatform()
        platform.isSupported = false
        platform.response = .success(.sharing(lowerBound: 18, upperBound: nil, declaration: .confirmed))
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal, .unavailable(.platformUnsupported))
        XCTAssertFalse(result.signal.isKnownAdult)
        XCTAssertNil(result.signal.bracket)
        XCTAssertEqual(platform.requestCount, 0, "an unsupported OS must not be asked")
    }

    func testUnsupportedPlatformStub() async {
        let result = await AgeAssuranceEvaluator.evaluate(
            platform: UnsupportedAgeRangePlatform(), configuration: recommended
        )
        XCTAssertEqual(result.signal, .unavailable(.platformUnsupported))
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testUserDeclinedIsUnavailableNotAdult() async {
        let platform = FakePlatform()
        platform.response = .success(.declinedSharing)
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal, .unavailable(.declinedSharing))
        XCTAssertFalse(result.signal.isKnownAdult)
        XCTAssertFalse(result.signal.isKnownMinor)
    }

    func testRequestFailureIsUnavailableNotAdult() async {
        let platform = FakePlatform()
        platform.response = .failure(FakeError())
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal, .unavailable(.requestFailed))
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testNoBoundsIsUnavailableNotAdult() async {
        let result = await evaluate(sharing(nil, nil))
        XCTAssertEqual(result.signal, .unavailable(.unrecognizedRange(lowerBound: nil, upperBound: nil)))
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testStraddlingRangesAreNotGuessed() async {
        for (lower, upper) in [(13, nil), (16, nil), (nil, 15), (nil, 17), (13, 17), (12, 13), (17, 18)] as [(Int?, Int?)] {
            let result = await evaluate(sharing(lower, upper))
            XCTAssertNil(result.signal.bracket, "\(String(describing: lower))-\(String(describing: upper)) must not map to a bracket")
            XCTAssertFalse(result.signal.isKnownAdult)
        }
    }

    func testInitialStateIsNotAnAdult() {
        XCTAssertEqual(AgeAssuranceResult.notYetRequested.signal, .unavailable(.notYetRequested))
        XCTAssertFalse(AgeAssuranceResult.notYetRequested.signal.isKnownAdult)
    }

    func testEveryUnavailableReasonIsNeitherAdultNorMinor() {
        let reasons: [AgeSignalUnavailableReason] = [
            .notYetRequested, .platformUnsupported, .notInScope, .declinedSharing,
            .requestFailed, .unrecognizedRange(lowerBound: 18, upperBound: 10),
        ]
        for reason in reasons {
            let signal = AgeSignal.unavailable(reason)
            XCTAssertFalse(signal.isKnownAdult, "\(reason)")
            XCTAssertFalse(signal.isKnownMinor, "\(reason)")
            XCTAssertNil(signal.bracket, "\(reason)")
        }
    }

    // MARK: request policy (decision D)

    func testOnlyWhenRequiredSkipsOutOfScopePeople() async {
        let platform = sharing(18, nil)
        platform.eligible = .success(false)
        platform.features = .success([])
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal, .unavailable(.notInScope))
        XCTAssertEqual(platform.requestCount, 0, "no sharing prompt for people no law covers")
        XCTAssertFalse(result.signal.isKnownAdult)
    }

    func testOnlyWhenRequiredAsksWhenEligible() async {
        let platform = sharing(13, 15)
        platform.eligible = .success(true)
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal.bracket, .age13to15)
        XCTAssertEqual(platform.requestCount, 1)
    }

    func testOnlyWhenRequiredAsksWhenRegulationRequires() async {
        let platform = sharing(16, 17)
        platform.eligible = .success(false)
        platform.features = .success([.declaredAgeRangeRequired, .significantChangeRequiresParentalConsent])
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal.bracket, .age16to17)
        XCTAssertEqual(result.requirements, [.declaredAgeRangeRequired, .significantChangeRequiresParentalConsent])
    }

    func testScopeCheckFailureStillAsks() async {
        let platform = sharing(nil, 12)
        platform.eligible = .failure(FakeError())
        let result = await evaluate(platform)
        XCTAssertEqual(result.signal.bracket, .under13)
        XCTAssertEqual(platform.requestCount, 1)
    }

    func testAlwaysPolicyAsksOutOfScopePeople() async {
        let platform = sharing(18, nil)
        platform.eligible = .success(false)
        let result = await evaluate(platform, AgeAssuranceConfiguration(requestPolicy: .always))
        XCTAssertEqual(result.signal.bracket, .adult)
        XCTAssertEqual(platform.requestCount, 1)
    }

    func testRecommendedConfigurationIsOnlyWhenRequired() {
        XCTAssertEqual(AgeAssuranceConfiguration.recommended.requestPolicy, .onlyWhenRequired)
    }

    // MARK: session

    func testSessionRequestsOncePerLaunchAndHoldsResult() async {
        let platform = sharing(16, 17)
        let session = AgeAssuranceSession(configuration: recommended, platform: platform)
        XCTAssertEqual(session.signal, .unavailable(.notYetRequested))
        await session.requestOnLaunch()
        await session.requestOnLaunch()
        XCTAssertEqual(session.signal.bracket, .age16to17)
        XCTAssertEqual(platform.requestCount, 1)
    }
}

final class SignificantChangeTests: XCTestCase {
    func testNarrowChangesAreSignificantEverywhere() {
        for change: ReleaseChange in [.addsDataCategories, .addsInAppPurchases, .addsAds, .changesAgeRating] {
            XCTAssertEqual(SignificantChange.states(for: change), Set(SignificantChangeState.allCases))
        }
    }

    func testFunctionalityChangeIsTexasAndLouisianaOnly() {
        XCTAssertEqual(SignificantChange.states(for: .materiallyChangesFunctionality), [.texas, .louisiana])
    }

    func testNoChangeIsNotSignificant() {
        XCTAssertTrue(SignificantChange.states(for: []).isEmpty)
    }

    func testActionPrefersParentalConsent() {
        XCTAssertEqual(SignificantChange.action(for: [.significantChangeRequiresParentalConsent, .significantChangeRequiresAdultNotification]), .askParent)
        XCTAssertEqual(SignificantChange.action(for: [.significantChangeRequiresAdultNotification]), .notifyAdult)
        XCTAssertEqual(SignificantChange.action(for: [.declaredAgeRangeRequired]), .none)
        XCTAssertEqual(SignificantChange.action(for: []), .none)
    }

    func testAgeRatingChange() {
        XCTAssertFalse(SignificantChange.ageRatingChanged(previous: nil, current: 4))
        XCTAssertFalse(SignificantChange.ageRatingChanged(previous: 4, current: nil))
        XCTAssertFalse(SignificantChange.ageRatingChanged(previous: 4, current: 4))
        XCTAssertTrue(SignificantChange.ageRatingChanged(previous: 4, current: 13))
    }
}
