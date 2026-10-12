import SwiftUI
import UIKit

// The signed-out intro (NativeIntro `present`), drawn in SwiftUI: a few
// pages telling what the app is for, then the two doors (create an account,
// or sign in). The words come from the web, in the app's language
// (NativeIntroModel.swift); the pictures are the brand's own greenhouse mark
// and its empty-state frame, redrawn here from frontend/public/brand/*.svg and
// frontend/src/components/illustrations, with SF Symbols inside the frame.
//
// Accessibility: every text style scales with Dynamic Type (the page scrolls
// when it no longer fits), the pictures are hidden from VoiceOver, each
// title is a heading that VoiceOver moves to when the page changes, the page
// indicator is one adjustable element ("Page 2 of 4", swipe up or down), and
// the escape gesture skips to the last page, or closes the intro from it.
// With Reduce Motion on, nothing moves except the system's own page swipe.

// MARK: - Palette (docs/brand.md)

enum IntroBrand {
    static let forest = Color(red: 0x17 / 255, green: 0x34 / 255, blue: 0x04 / 255)
    static let canopy = Color(red: 0x27 / 255, green: 0x50 / 255, blue: 0x0A / 255)
    static let leafDark = Color(red: 0x3B / 255, green: 0x6D / 255, blue: 0x11 / 255)
    static let leafMid = Color(red: 0x63 / 255, green: 0x99 / 255, blue: 0x22 / 255)
    static let leafLight = Color(red: 0x97 / 255, green: 0xC4 / 255, blue: 0x59 / 255)
    static let glass = Color(red: 0xDD / 255, green: 0xEE / 255, blue: 0xE7 / 255)
    static let dew = Color(red: 0xB7 / 255, green: 0xD9 / 255, blue: 0xD1 / 255)
    static let paper = Color(red: 0xF7 / 255, green: 0xF8 / 255, blue: 0xF2 / 255)
    static let parchment = Color(red: 0xEE / 255, green: 0xF1 / 255, blue: 0xE6 / 255)
    static let terracotta = Color(red: 0xDC / 255, green: 0x6C / 255, blue: 0x1F / 255)
    /// The darker terracotta the light mark uses for its threshold.
    static let terracottaDeep = Color(red: 0xA2 / 255, green: 0x3F / 255, blue: 0x1A / 255)
    static let sprout = Color(red: 0xC0 / 255, green: 0xDD / 255, blue: 0x97 / 255)
    static let mist = Color(red: 0xEA / 255, green: 0xF3 / 255, blue: 0xDE / 255)
    static let sunLight = Color(red: 0xD7 / 255, green: 0xE8 / 255, blue: 0xA9 / 255)
}

/// Daylight on Paper, or the launch screen's Forest at night.
struct IntroColors {
    let background: Color
    let title: Color
    let body: Color
    let eyebrow: Color
    let primaryFill: Color
    let primaryText: Color
    let secondaryFill: Color
    let secondaryText: Color
    let secondaryStroke: Color
    let link: Color
    let dot: Color
    let dotCurrent: Color
    let frameFill: Color
    let frameStroke: Color
    let frameMullion: Color
    let symbol: Color
    let badge: Color
    let badgeRing: Color

    static func of(_ scheme: ColorScheme) -> IntroColors {
        if scheme == .dark {
            return IntroColors(
                background: IntroBrand.forest,
                title: IntroBrand.paper,
                body: IntroBrand.glass,
                eyebrow: IntroBrand.leafLight,
                primaryFill: IntroBrand.leafLight,
                primaryText: IntroBrand.forest,
                secondaryFill: Color.white.opacity(0.08),
                secondaryText: IntroBrand.paper,
                secondaryStroke: IntroBrand.dew.opacity(0.55),
                link: IntroBrand.leafLight,
                dot: IntroBrand.paper.opacity(0.35),
                dotCurrent: IntroBrand.leafLight,
                frameFill: IntroBrand.canopy.opacity(0.55),
                frameStroke: IntroBrand.dew.opacity(0.45),
                frameMullion: IntroBrand.dew.opacity(0.25),
                symbol: IntroBrand.leafLight,
                badge: IntroBrand.paper,
                badgeRing: IntroBrand.forest
            )
        }
        return IntroColors(
            background: IntroBrand.paper,
            title: IntroBrand.canopy,
            body: IntroBrand.forest.opacity(0.82),
            eyebrow: IntroBrand.leafDark,
            primaryFill: IntroBrand.forest,
            primaryText: IntroBrand.paper,
            secondaryFill: IntroBrand.glass,
            secondaryText: IntroBrand.canopy,
            secondaryStroke: IntroBrand.dew,
            link: IntroBrand.canopy,
            dot: IntroBrand.dew,
            dotCurrent: IntroBrand.leafDark,
            frameFill: IntroBrand.parchment,
            frameStroke: IntroBrand.dew,
            frameMullion: IntroBrand.dew.opacity(0.8),
            symbol: IntroBrand.leafMid,
            badge: IntroBrand.canopy,
            badgeRing: IntroBrand.paper
        )
    }
}

// MARK: - The intro

struct IntroView: View {
    let session: IntroSession
    /// Takes the intro down (NativeIntroPlugin), after it has answered.
    let onFinish: () -> Void

    @State private var index = 0
    @AccessibilityFocusState private var focusedTitle: Int?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private let selection = UISelectionFeedbackGenerator()
    private let impact = UIImpactFeedbackGenerator(style: .light)

    private var request: IntroRequest { session.request }
    private var pages: [IntroPage] { request.shownPages }
    private var lastIndex: Int { pages.count - 1 }
    private var onLast: Bool { request.isLast(index) }

    var body: some View {
        let colors = IntroColors.of(scheme)
        ZStack {
            colors.background.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar(colors)
                TabView(selection: $index) {
                    ForEach(Array(pages.enumerated()), id: \.offset) { offset, page in
                        IntroPageView(
                            page: page,
                            index: offset,
                            isLast: request.isLast(offset),
                            appName: request.appName,
                            tagline: request.tagline,
                            active: index == offset,
                            colors: colors,
                            focusedTitle: $focusedTitle
                        )
                        .tag(offset)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                bottomBar(colors)
            }
            .frame(maxWidth: 560)
        }
        .onAppear {
            selection.prepare()
            impact.prepare()
            #if DEBUG
            IntroScreenshotHook.apply(lastIndex: lastIndex) { go(to: $0) }
            #endif
        }
        .onChange(of: index) { newIndex in
            selection.selectionChanged()
            selection.prepare()
            focusedTitle = newIndex
        }
        .accessibilityAction(.escape) { escape() }
    }

    // MARK: Bars

    @ViewBuilder
    private func topBar(_ colors: IntroColors) -> some View {
        HStack {
            Spacer()
            if !onLast {
                Button(request.skip) { go(to: lastIndex) }
                    .font(.body.weight(.semibold))
                    .foregroundColor(colors.link)
                    .padding(.horizontal, 20)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("intro-skip")
            }
        }
        // The same height with or without Skip, so the page does not jump.
        .frame(minHeight: 44)
        .padding(.top, 4)
    }

    @ViewBuilder
    private func bottomBar(_ colors: IntroColors) -> some View {
        VStack(spacing: 16) {
            if pages.count > 1 {
                IntroPageDots(
                    count: pages.count,
                    index: $index,
                    label: request.position(index),
                    colors: colors,
                    reduceMotion: reduceMotion
                )
            }
            if onLast {
                VStack(spacing: 12) {
                    if let create = request.create {
                        IntroButton(title: create, prominent: true, colors: colors) { choose(.create) }
                            .accessibilityIdentifier("intro-create")
                    }
                    IntroButton(title: request.signIn, prominent: request.create == nil, colors: colors) {
                        choose(.signIn)
                    }
                    .accessibilityIdentifier("intro-sign-in")
                }
            } else {
                IntroButton(title: request.next, prominent: true, colors: colors) { go(to: index + 1) }
                    .accessibilityIdentifier("intro-next")
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    // MARK: Actions

    private func go(to target: Int) {
        let clamped = min(max(target, 0), lastIndex)
        guard clamped != index else { return }
        if reduceMotion {
            index = clamped
        } else {
            withAnimation(.easeInOut(duration: 0.35)) { index = clamped }
        }
    }

    private func choose(_ choice: IntroChoice) {
        impact.impactOccurred()
        if session.choose(choice) { onFinish() }
    }

    /// VoiceOver's escape: from a story page, to the last page (what Skip
    /// does); from the last page, closed with no choice, which leaves the
    /// web's sign-in screen showing.
    private func escape() {
        if onLast {
            session.close()
            onFinish()
        } else {
            go(to: lastIndex)
        }
    }
}

#if DEBUG
/// For simulator screenshots and recordings only; compiled out of Release
/// builds. With `SIMCTL_CHILD_FG_INTRO_PAGE=n` the intro opens on page n
/// (from 0); with `SIMCTL_CHILD_FG_INTRO_AUTOPLAY=s` it moves to the next
/// page every s seconds, the way a swipe or Next would.
enum IntroScreenshotHook {
    static func apply(lastIndex: Int, go: @escaping (Int) -> Void) {
        let environment = ProcessInfo.processInfo.environment
        var page = Int(environment["FG_INTRO_PAGE"] ?? "") ?? 0
        if page > 0 { go(min(page, lastIndex)) }
        guard let seconds = Double(environment["FG_INTRO_AUTOPLAY"] ?? ""), seconds > 0 else { return }
        func step() {
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                guard page < lastIndex else { return }
                page += 1
                go(page)
                step()
            }
        }
        step()
    }
}
#endif

// MARK: - One page

struct IntroPageView: View {
    let page: IntroPage
    let index: Int
    let isLast: Bool
    let appName: String
    let tagline: String
    let active: Bool
    let colors: IntroColors
    var focusedTitle: AccessibilityFocusState<Int?>.Binding

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var artHeight: CGFloat {
        if verticalSizeClass == .compact { return 104 }
        if typeSize.isAccessibilitySize { return 150 }
        return 250
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 20) {
                    IntroIllustration(id: page.id, active: active, colors: colors)
                        .frame(height: artHeight)
                        .frame(maxWidth: .infinity)
                        .accessibilityHidden(true)
                    if isLast && !appName.isEmpty {
                        VStack(spacing: 4) {
                            Text(appName)
                                .font(.system(.title3, design: .serif))
                                .foregroundColor(colors.title)
                            if !tagline.isEmpty {
                                Text(tagline.uppercased())
                                    .font(.caption.weight(.semibold))
                                    .tracking(2.2)
                                    .foregroundColor(colors.eyebrow)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    Text(page.title)
                        .font(.system(.largeTitle, design: .serif))
                        .foregroundColor(colors.title)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused(focusedTitle, equals: index)
                    if !page.body.isEmpty {
                        Text(page.body)
                            .font(.body)
                            .foregroundColor(colors.body)
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
        }
    }
}

// MARK: - Controls

struct IntroButton: View {
    let title: String
    let prominent: Bool
    let colors: IntroColors
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 52)
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
                .foregroundColor(prominent ? colors.primaryText : colors.secondaryText)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(prominent ? colors.primaryFill : colors.secondaryFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(prominent ? Color.clear : colors.secondaryStroke, lineWidth: 1)
                )
                .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(IntroPressStyle())
    }
}

/// A slight press, like a system button.
struct IntroPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

/// The page indicator: tap a dot to go to that page. For VoiceOver it is one
/// adjustable element that reads "Page 2 of 4".
struct IntroPageDots: View {
    let count: Int
    @Binding var index: Int
    let label: String
    let colors: IntroColors
    let reduceMotion: Bool

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { dot in
                Button {
                    move(to: dot)
                } label: {
                    Capsule()
                        .fill(dot == index ? colors.dotCurrent : colors.dot)
                        .frame(width: dot == index ? 22 : 8, height: 8)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: index)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: move(to: index + 1)
            case .decrement: move(to: index - 1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("intro-page-dots")
    }

    private func move(to target: Int) {
        let clamped = min(max(target, 0), count - 1)
        guard clamped != index else { return }
        if reduceMotion {
            index = clamped
        } else {
            withAnimation(.easeInOut(duration: 0.35)) { index = clamped }
        }
    }
}

// MARK: - Illustrations

/// The picture for a page id. An id this build does not know draws nothing.
struct IntroIllustration: View {
    let id: String
    let active: Bool
    let colors: IntroColors

    var body: some View {
        switch id {
        case "household":
            GreenhouseMark(grown: active, plate: false)
        case "claim":
            FramedSymbol(symbol: "drop.fill", badge: "checkmark.circle.fill", shown: active, colors: colors)
        case "away":
            FramedSymbol(symbol: "suitcase.rolling.fill", badge: "link.circle.fill", shown: active, colors: colors)
        case "start":
            GreenhouseMark(grown: active, plate: true)
        default:
            Color.clear
        }
    }
}

/// The empty-state art's greenhouse frame (240 x 180,
/// src/components/illustrations/EmptyTasks.tsx), with an SF Symbol inside and
/// a badge that settles on its corner when the page comes into view.
struct FramedSymbol: View {
    let symbol: String
    let badge: String
    let shown: Bool
    let colors: IntroColors

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = false

    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width / 240, proxy.size.height / 180)
            let width = 240 * scale
            let height = 180 * scale
            ZStack(alignment: .topLeading) {
                Path { path in
                    path.move(to: CGPoint(x: 36, y: 148))
                    path.addLine(to: CGPoint(x: 36, y: 68))
                    path.addLine(to: CGPoint(x: 120, y: 22))
                    path.addLine(to: CGPoint(x: 204, y: 68))
                    path.addLine(to: CGPoint(x: 204, y: 148))
                }
                .applying(CGAffineTransform(scaleX: scale, y: scale))
                .fill(colors.frameFill)
                Path { path in
                    path.move(to: CGPoint(x: 36, y: 148))
                    path.addLine(to: CGPoint(x: 36, y: 68))
                    path.addLine(to: CGPoint(x: 120, y: 22))
                    path.addLine(to: CGPoint(x: 204, y: 68))
                    path.addLine(to: CGPoint(x: 204, y: 148))
                }
                .applying(CGAffineTransform(scaleX: scale, y: scale))
                .stroke(colors.frameStroke, style: StrokeStyle(lineWidth: 2 * scale, lineJoin: .round))
                Path { path in
                    path.move(to: CGPoint(x: 120, y: 23))
                    path.addLine(to: CGPoint(x: 120, y: 148))
                    path.move(to: CGPoint(x: 37, y: 68))
                    path.addLine(to: CGPoint(x: 203, y: 68))
                }
                .applying(CGAffineTransform(scaleX: scale, y: scale))
                .stroke(colors.frameMullion, lineWidth: 1.5 * scale)
                Ellipse()
                    .fill(colors.frameStroke.opacity(0.6))
                    .frame(width: 128 * scale, height: 12 * scale)
                    .offset(x: 56 * scale, y: 154 * scale)
                ZStack(alignment: .topTrailing) {
                    Image(systemName: symbol)
                        .resizable()
                        .scaledToFit()
                        .foregroundColor(colors.symbol)
                        .frame(width: 64 * scale, height: 64 * scale)
                        .frame(width: 100 * scale, height: 84 * scale)
                        .background(
                            RoundedRectangle(cornerRadius: 18 * scale, style: .continuous)
                                .fill(colors.background)
                        )
                    Image(systemName: badge)
                        .resizable()
                        .scaledToFit()
                        .foregroundColor(colors.badge)
                        .background(Circle().fill(colors.badgeRing).padding(-3 * scale))
                        .frame(width: 30 * scale, height: 30 * scale)
                        .offset(x: 12 * scale, y: -12 * scale)
                        .scaleEffect(settled || reduceMotion ? 1 : 0.2, anchor: .center)
                        .opacity(settled || reduceMotion ? 1 : 0)
                }
                .offset(x: 70 * scale, y: 58 * scale)
            }
            .frame(width: width, height: height)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { settle(shown) }
        .onChange(of: shown) { settle($0) }
    }

    private func settle(_ now: Bool) {
        guard !reduceMotion else { return }
        if now {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.62).delay(0.25)) { settled = true }
        } else {
            settled = false
        }
    }
}

/// The greenhouse mark (frontend/public/brand/icon.svg, and icon-on-green.svg
/// at night), drawn in its own 512-unit space. Its two plants grow up from
/// the threshold when the page comes into view. `plate` draws it on the app
/// icon's rounded plate, as on the home screen.
struct GreenhouseMark: View {
    let grown: Bool
    let plate: Bool

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var growth: CGFloat = 0

    private var night: Bool { scheme == .dark || plate }

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let s = side / 512
            ZStack(alignment: .topLeading) {
                if plate {
                    RoundedRectangle(cornerRadius: 114 * s, style: .continuous)
                        .fill(IntroBrand.forest)
                        .overlay(
                            RoundedRectangle(cornerRadius: 114 * s, style: .continuous)
                                .stroke(IntroBrand.dew.opacity(scheme == .dark ? 0.35 : 0), lineWidth: 1)
                        )
                        .frame(width: side, height: side)
                }
                Circle()
                    .fill(night ? IntroBrand.leafLight.opacity(0.75) : IntroBrand.sunLight)
                    .frame(width: 84 * s, height: 84 * s)
                    .offset(x: 340 * s, y: 64 * s)
                    .opacity(0.4 + 0.6 * growth)
                shape(s) { p in
                    p.move(to: pt(96, 224)); p.addLine(to: pt(256, 82)); p.addLine(to: pt(416, 224))
                    p.addLine(to: pt(416, 426)); p.addLine(to: pt(96, 426)); p.closeSubpath()
                }
                .fill(night ? IntroBrand.mist : IntroBrand.glass)
                shape(s) { p in
                    p.move(to: pt(96, 224)); p.addLine(to: pt(256, 82)); p.addLine(to: pt(416, 224))
                    p.move(to: pt(96, 224)); p.addLine(to: pt(416, 224)); p.addLine(to: pt(416, 426))
                    p.addLine(to: pt(96, 426)); p.closeSubpath()
                }
                .stroke(night ? IntroBrand.sprout : IntroBrand.canopy,
                        style: StrokeStyle(lineWidth: 14 * s, lineJoin: .round))
                shape(s) { p in
                    p.move(to: pt(256, 88)); p.addLine(to: pt(256, 426))
                    p.move(to: pt(103, 225)); p.addLine(to: pt(409, 225))
                }
                .stroke(night ? IntroBrand.leafMid.opacity(0.55) : IntroBrand.leafDark.opacity(0.42), lineWidth: 7 * s)
                shape(s) { p in
                    p.move(to: pt(112, 238)); p.addLine(to: pt(112, 412)); p.addLine(to: pt(400, 412)); p.addLine(to: pt(400, 238))
                    p.move(to: pt(112, 240)); p.addLine(to: pt(256, 112)); p.addLine(to: pt(400, 240))
                }
                .stroke(Color.white.opacity(night ? 0.48 : 0.6), lineWidth: 8 * s)
                plant(s, stemX: 160, top: 276, leaves: leftLeaves, fill: IntroBrand.leafMid)
                plant(s, stemX: 352, top: 270, leaves: rightLeaves, fill: IntroBrand.leafLight)
                shape(s) { p in
                    p.move(to: pt(218, 426)); p.addLine(to: pt(218, 312)); p.addLine(to: pt(294, 312)); p.addLine(to: pt(294, 426))
                }
                .fill(IntroBrand.sprout)
                shape(s) { p in
                    p.move(to: pt(218, 426)); p.addLine(to: pt(218, 312)); p.addLine(to: pt(294, 312)); p.addLine(to: pt(294, 426))
                }
                .stroke(IntroBrand.canopy, style: StrokeStyle(lineWidth: 9 * s, lineJoin: .round))
                Circle()
                    .fill(IntroBrand.terracottaDeep)
                    .frame(width: 12 * s, height: 12 * s)
                    .offset(x: 272 * s, y: 364 * s)
                // The shared threshold: the one warm accent on the page.
                shape(s) { p in p.move(to: pt(82, 426)); p.addLine(to: pt(430, 426)) }
                    .stroke(night ? IntroBrand.terracotta : IntroBrand.terracottaDeep,
                            style: StrokeStyle(lineWidth: 18 * s, lineCap: .round))
            }
            .frame(width: side, height: side)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
        .onAppear { grow(grown) }
        .onChange(of: grown) { grow($0) }
    }

    private func grow(_ now: Bool) {
        if reduceMotion {
            growth = 1
        } else if now {
            growth = 0.35
            withAnimation(.spring(response: 0.9, dampingFraction: 0.7).delay(0.15)) { growth = 1 }
        }
    }

    /// One plant: a stem from the soil line and two leaves, scaled up from
    /// the soil as `growth` goes from 0 to 1.
    private func plant(_ s: CGFloat, stemX: CGFloat, top: CGFloat, leaves: (inout Path) -> Void, fill: Color) -> some View {
        ZStack(alignment: .topLeading) {
            shape(s, leaves).fill(fill)
            shape(s) { p in
                p.move(to: pt(stemX, 404)); p.addLine(to: pt(stemX, top))
                leaves(&p)
            }
            .stroke(IntroBrand.canopy, style: StrokeStyle(lineWidth: 8 * s, lineCap: .round, lineJoin: .round))
        }
        .scaleEffect(max(growth, 0.001), anchor: UnitPoint(x: stemX / 512, y: 404 / 512))
    }

    private let leftLeaves: (inout Path) -> Void = { p in
        p.move(to: CGPoint(x: 160, y: 316))
        p.addCurve(to: CGPoint(x: 106, y: 265), control1: CGPoint(x: 127, y: 314), control2: CGPoint(x: 109, y: 295))
        p.addCurve(to: CGPoint(x: 160, y: 316), control1: CGPoint(x: 139, y: 265), control2: CGPoint(x: 159, y: 283))
        p.closeSubpath()
        p.move(to: CGPoint(x: 160, y: 356))
        p.addCurve(to: CGPoint(x: 222, y: 299), control1: CGPoint(x: 197, y: 354), control2: CGPoint(x: 218, y: 334))
        p.addCurve(to: CGPoint(x: 160, y: 356), control1: CGPoint(x: 185, y: 300), control2: CGPoint(x: 163, y: 319))
        p.closeSubpath()
    }

    private let rightLeaves: (inout Path) -> Void = { p in
        p.move(to: CGPoint(x: 352, y: 308))
        p.addCurve(to: CGPoint(x: 406, y: 257), control1: CGPoint(x: 385, y: 306), control2: CGPoint(x: 403, y: 287))
        p.addCurve(to: CGPoint(x: 352, y: 308), control1: CGPoint(x: 373, y: 257), control2: CGPoint(x: 353, y: 275))
        p.closeSubpath()
        p.move(to: CGPoint(x: 352, y: 352))
        p.addCurve(to: CGPoint(x: 290, y: 295), control1: CGPoint(x: 315, y: 350), control2: CGPoint(x: 294, y: 330))
        p.addCurve(to: CGPoint(x: 352, y: 352), control1: CGPoint(x: 327, y: 296), control2: CGPoint(x: 349, y: 315))
        p.closeSubpath()
    }

    private func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

    /// A path drawn in the mark's 512-unit space, scaled to the view.
    private func shape(_ s: CGFloat, _ build: (inout Path) -> Void) -> Path {
        var path = Path()
        build(&path)
        return path.applying(CGAffineTransform(scaleX: s, y: s))
    }
}
