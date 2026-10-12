package net.familygreenhouse.app.intro

import android.animation.ValueAnimator
import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ColorFilter
import kotlinx.coroutines.launch
import net.familygreenhouse.app.R
import net.familygreenhouse.app.frame.FgTheme

// The signed-out intro (NativeIntro `present`), drawn in Jetpack Compose: a
// few pages telling what the app is for, then the two doors (create an
// account, or sign in). A port of ios/App/App/NativeIntroView.swift, in
// Material's terms: a horizontal pager, a filled button for the main door and
// an outlined one for the other, Skip as a text button. The words come from
// the web (NativeIntroModel.kt); the pictures are the brand's greenhouse mark
// and its empty-state frame, redrawn here from frontend/public/brand/*.svg and
// frontend/src/components/illustrations, with Material Symbols standing in for
// the SF Symbols inside the frame.
//
// Accessibility: text follows the system font scale (each page scrolls when
// it no longer fits), the pictures are hidden from TalkBack, each title is a
// heading and the page is a pane TalkBack announces when it changes, and the
// page indicator is one adjustable element ("Page 2 of 4"). Back pages
// backward (NativeIntroPlugin.kt). With Remove animations on, pages change
// without sliding and nothing grows.
//
// Light only, like the rest of the Android app (FgTheme.kt) and, under its
// Info.plist pin, the iOS intro.

/** docs/brand.md: the colors the iOS intro uses in daylight. */
private object IntroBrand {
    val forest = Color(0xFF173404)
    val canopy = Color(0xFF27500A)
    val leafDark = Color(0xFF3B6D11)
    val leafMid = Color(0xFF639922)
    val leafLight = Color(0xFF97C459)
    val glass = Color(0xFFDDEEE7)
    val dew = Color(0xFFB7D9D1)
    val paper = Color(0xFFF7F8F2)
    val parchment = Color(0xFFEEF1E6)
    val terracottaDeep = Color(0xFFA23F1A)
    val sprout = Color(0xFFC0DD97)
    val sunLight = Color(0xFFD7E8A9)
}

private fun animationsOn(): Boolean = ValueAnimator.areAnimatorsEnabled()

@Composable
fun IntroScreen(session: IntroSession, page: MutableIntState, onFinish: () -> Unit) {
    FgTheme {
        IntroContent(session, page, onFinish)
    }
}

@Composable
private fun IntroContent(session: IntroSession, page: MutableIntState, onFinish: () -> Unit) {
    val request = session.request
    val pages = request.shownPages
    val lastIndex = pages.size - 1
    val pager = rememberPagerState(initialPage = 0) { pages.size }
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val motion = remember { animationsOn() }

    fun go(target: Int) {
        val clamped = target.coerceIn(0, lastIndex)
        if (clamped == pager.currentPage) return
        scope.launch { if (motion) pager.animateScrollToPage(clamped) else pager.scrollToPage(clamped) }
    }

    // The pager and back (which sets `page`) stay in step.
    LaunchedEffect(pager) {
        snapshotFlow { pager.currentPage }.collect { current ->
            if (page.intValue != current) {
                page.intValue = current
                view.performHapticFeedback(
                    if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK
                    else HapticFeedbackConstants.CLOCK_TICK,
                )
            }
        }
    }
    LaunchedEffect(page.intValue) { go(page.intValue) }

    fun choose(choice: IntroChoice) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM
            else HapticFeedbackConstants.VIRTUAL_KEY,
        )
        if (session.choose(choice)) onFinish()
    }

    val onLast = request.isLast(pager.currentPage)
    Box(
        Modifier
            .fillMaxSize()
            .background(IntroBrand.paper)
            .windowInsetsPadding(WindowInsets.safeDrawing),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(Modifier.fillMaxSize().widthIn(max = 560.dp)) {
            // The same height with or without Skip, so the page does not jump.
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 4.dp, end = 8.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!onLast) {
                    TextButton(
                        onClick = { go(lastIndex) },
                        modifier = Modifier.semantics { testTag = "intro-skip" },
                    ) {
                        Text(request.skip, fontWeight = FontWeight.SemiBold, color = IntroBrand.canopy)
                    }
                }
            }
            HorizontalPager(
                state = pager,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                beyondViewportPageCount = 1,
            ) { index ->
                IntroPageView(
                    page = pages[index],
                    isLast = request.isLast(index),
                    appName = request.appName,
                    tagline = request.tagline,
                    active = pager.currentPage == index,
                    motion = motion,
                )
            }
            Column(
                Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (pages.size > 1) {
                    IntroPageDots(
                        count = pages.size,
                        index = pager.currentPage,
                        label = request.position(pager.currentPage),
                        onMove = ::go,
                    )
                }
                if (onLast) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        request.create?.let { create ->
                            IntroButton(create, prominent = true, tag = "intro-create") { choose(IntroChoice.CREATE) }
                        }
                        IntroButton(request.signIn, prominent = request.create == null, tag = "intro-sign-in") {
                            choose(IntroChoice.SIGN_IN)
                        }
                    }
                } else {
                    IntroButton(request.next, prominent = true, tag = "intro-next") { go(pager.currentPage + 1) }
                }
            }
        }
    }
}

@Composable
private fun IntroPageView(
    page: IntroPage,
    isLast: Boolean,
    appName: String,
    tagline: String,
    active: Boolean,
    motion: Boolean,
) {
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .semantics { if (active) paneTitle = page.title },
    ) {
        val compact = maxHeight < 420.dp
        val large = MaterialTheme.typography.bodyLarge.fontSize.value *
            androidx.compose.ui.platform.LocalDensity.current.fontScale > 24f
        val artHeight: Dp = when {
            compact -> 104.dp
            large -> 150.dp
            else -> 250.dp
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.fillMaxWidth().heightIn(min = artHeight, max = artHeight).clearAndSetSemantics {}) {
                IntroIllustration(page.id, active, motion)
            }
            if (isLast && appName.isNotEmpty()) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.semantics(mergeDescendants = true) {},
                ) {
                    Text(appName, fontFamily = FontFamily.Serif, fontSize = 20.sp, color = IntroBrand.canopy)
                    if (tagline.isNotEmpty()) {
                        Text(
                            tagline.uppercase(),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = 2.2.sp,
                            color = IntroBrand.leafDark,
                        )
                    }
                }
            }
            Text(
                page.title,
                fontFamily = FontFamily.Serif,
                fontSize = 32.sp,
                lineHeight = 38.sp,
                color = IntroBrand.canopy,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            if (page.body.isNotEmpty()) {
                Text(
                    page.body,
                    style = MaterialTheme.typography.bodyLarge,
                    lineHeight = 25.sp,
                    color = IntroBrand.forest.copy(alpha = 0.82f),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun IntroButton(title: String, prominent: Boolean, tag: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    val modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).semantics { testTag = tag }
    if (prominent) {
        Button(
            onClick = onClick,
            modifier = modifier,
            shape = shape,
            colors = ButtonDefaults.buttonColors(containerColor = IntroBrand.forest, contentColor = IntroBrand.paper),
        ) {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, textAlign = TextAlign.Center)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier,
            shape = shape,
            border = BorderStroke(1.dp, IntroBrand.dew),
            colors = ButtonDefaults.outlinedButtonColors(containerColor = IntroBrand.glass, contentColor = IntroBrand.canopy),
        ) {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, textAlign = TextAlign.Center)
        }
    }
}

/**
 * The page indicator: tap a dot to go to that page. For TalkBack it is one
 * adjustable element that reads "Page 2 of 4" (volume keys or swipe up and
 * down move it).
 */
@Composable
private fun IntroPageDots(count: Int, index: Int, label: String, onMove: (Int) -> Unit) {
    Row(
        Modifier
            .clearAndSetSemantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(index.toFloat(), 0f..(count - 1).toFloat(), count - 2)
                setProgress { target ->
                    onMove(Math.round(target))
                    true
                }
                testTag = "intro-page-dots"
            },
    ) {
        for (dot in 0 until count) {
            val width by animateDpAsState(
                targetValue = if (dot == index) 22.dp else 8.dp,
                animationSpec = if (animationsOn()) tween(250) else tween(0),
                label = "dot",
            )
            Box(
                Modifier.size(30.dp).clickable { onMove(dot) },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .size(width = width, height = 8.dp)
                        .clip(CircleShape)
                        .background(if (dot == index) IntroBrand.leafDark else IntroBrand.dew),
                )
            }
        }
    }
}

// ---- Illustrations ------------------------------------------------------

/** The picture for a page id. An id this build does not know draws nothing. */
@Composable
private fun IntroIllustration(id: String, active: Boolean, motion: Boolean) {
    when (id) {
        "household" -> GreenhouseMark(grown = active, plate = false, motion = motion)
        "claim" -> FramedSymbol(R.drawable.ic_fg_water_drop_fill, R.drawable.ic_fg_check_circle_fill, false, active, motion)
        "away" -> FramedSymbol(R.drawable.ic_fg_luggage_fill, R.drawable.ic_fg_link, true, active, motion)
        "start" -> GreenhouseMark(grown = active, plate = true, motion = motion)
        else -> Unit
    }
}

/**
 * The empty-state art's greenhouse frame (240 x 180,
 * src/components/illustrations/EmptyTasks.tsx), with a symbol inside and a
 * badge that settles on its corner when the page comes into view. iOS uses
 * `checkmark.circle.fill` and `link.circle.fill`; [badgeInCircle] draws the
 * link on a filled circle the way the second one is.
 */
@Composable
private fun FramedSymbol(symbol: Int, badge: Int, badgeInCircle: Boolean, shown: Boolean, motion: Boolean) {
    val settle = remember { Animatable(if (motion) 0f else 1f) }
    LaunchedEffect(shown) {
        if (!motion) return@LaunchedEffect settle.snapTo(1f)
        if (shown) {
            kotlinx.coroutines.delay(250)
            settle.animateTo(1f, spring(dampingRatio = 0.62f, stiffness = Spring.StiffnessLow))
        } else {
            settle.snapTo(0f)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val scale = minOf(maxWidth.value / 240f, maxHeight.value / 180f)
        Box(Modifier.size((240 * scale).dp, (180 * scale).dp)) {
            Canvas(Modifier.fillMaxSize()) {
                val s = size.width / 240f
                val frame = Path().apply {
                    moveTo(36 * s, 148 * s); lineTo(36 * s, 68 * s); lineTo(120 * s, 22 * s)
                    lineTo(204 * s, 68 * s); lineTo(204 * s, 148 * s)
                }
                drawPath(frame, IntroBrand.parchment)
                drawPath(frame, IntroBrand.dew, style = Stroke(width = 2 * s, join = StrokeJoin.Round))
                val mullions = Path().apply {
                    moveTo(120 * s, 23 * s); lineTo(120 * s, 148 * s)
                    moveTo(37 * s, 68 * s); lineTo(203 * s, 68 * s)
                }
                drawPath(mullions, IntroBrand.dew.copy(alpha = 0.8f), style = Stroke(width = 1.5f * s))
                drawOval(IntroBrand.dew.copy(alpha = 0.6f), Offset(56 * s, 154 * s), Size(128 * s, 12 * s))
                drawRoundRect(
                    IntroBrand.paper,
                    Offset(70 * s, 58 * s),
                    Size(100 * s, 84 * s),
                    CornerRadius(18 * s, 18 * s),
                )
            }
            Image(
                painterResource(symbol),
                contentDescription = null,
                colorFilter = ColorFilter.tint(IntroBrand.leafMid),
                modifier = Modifier
                    .padding(start = (88 * scale).dp, top = (68 * scale).dp)
                    .size((64 * scale).dp),
            )
            Box(
                Modifier
                    .padding(start = (152 * scale).dp, top = (43 * scale).dp)
                    .size((36 * scale).dp)
                    .scale(0.2f + 0.8f * settle.value)
                    .alpha(settle.value.coerceIn(0f, 1f))
                    .clip(CircleShape)
                    .background(IntroBrand.paper),
                contentAlignment = Alignment.Center,
            ) {
                if (badgeInCircle) {
                    Box(
                        Modifier.size((30 * scale).dp).clip(CircleShape).background(IntroBrand.canopy),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            painterResource(badge),
                            contentDescription = null,
                            colorFilter = ColorFilter.tint(IntroBrand.paper),
                            modifier = Modifier.size((20 * scale).dp),
                        )
                    }
                } else {
                    Image(
                        painterResource(badge),
                        contentDescription = null,
                        colorFilter = ColorFilter.tint(IntroBrand.canopy),
                        modifier = Modifier.size((34 * scale).dp),
                    )
                }
            }
        }
    }
}

/**
 * The greenhouse mark (frontend/public/brand/icon.svg, and icon-on-green.svg
 * on the app icon's plate), drawn in its own 512-unit space. Its two plants
 * grow up from the threshold when the page comes into view.
 */
@Composable
private fun GreenhouseMark(grown: Boolean, plate: Boolean, motion: Boolean) {
    val growth = remember { Animatable(if (motion) 0f else 1f) }
    LaunchedEffect(grown) {
        if (!motion) return@LaunchedEffect growth.snapTo(1f)
        if (grown) {
            growth.snapTo(0.35f)
            kotlinx.coroutines.delay(150)
            growth.animateTo(1f, spring(dampingRatio = 0.7f, stiffness = Spring.StiffnessVeryLow))
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val side = minOf(maxWidth, maxHeight)
            Canvas(Modifier.size(side).align(Alignment.Center)) {
                val s = size.minDimension / 512f
                withTransform({ scale(s, s, Offset.Zero) }) { drawMark(plate, growth.value) }
            }
        }
    }
}

private fun DrawScope.drawMark(night: Boolean, growth: Float) {
    if (night) {
        drawRoundRect(IntroBrand.forest, Offset.Zero, Size(512f, 512f), CornerRadius(114f, 114f))
    }
    drawCircle(
        (if (night) IntroBrand.leafLight.copy(alpha = 0.75f) else IntroBrand.sunLight)
            .copy(alpha = (if (night) 0.75f else 1f) * (0.4f + 0.6f * growth)),
        radius = 42f,
        center = Offset(382f, 106f),
    )
    val house = Path().apply {
        moveTo(96f, 224f); lineTo(256f, 82f); lineTo(416f, 224f)
        lineTo(416f, 426f); lineTo(96f, 426f); close()
    }
    drawPath(house, if (night) Color(0xFFEAF3DE) else IntroBrand.glass)
    val outline = Path().apply {
        moveTo(96f, 224f); lineTo(256f, 82f); lineTo(416f, 224f)
        moveTo(96f, 224f); lineTo(416f, 224f); lineTo(416f, 426f); lineTo(96f, 426f); close()
    }
    drawPath(outline, if (night) IntroBrand.sprout else IntroBrand.canopy, style = Stroke(14f, join = StrokeJoin.Round))
    val mullions = Path().apply {
        moveTo(256f, 88f); lineTo(256f, 426f)
        moveTo(103f, 225f); lineTo(409f, 225f)
    }
    drawPath(
        mullions,
        if (night) IntroBrand.leafMid.copy(alpha = 0.55f) else IntroBrand.leafDark.copy(alpha = 0.42f),
        style = Stroke(7f),
    )
    val glint = Path().apply {
        moveTo(112f, 238f); lineTo(112f, 412f); lineTo(400f, 412f); lineTo(400f, 238f)
        moveTo(112f, 240f); lineTo(256f, 112f); lineTo(400f, 240f)
    }
    drawPath(glint, Color.White.copy(alpha = if (night) 0.48f else 0.6f), style = Stroke(8f))

    drawPlant(160f, 276f, leftLeaves(), IntroBrand.leafMid, growth)
    drawPlant(352f, 270f, rightLeaves(), IntroBrand.leafLight, growth)

    val door = Path().apply { moveTo(218f, 426f); lineTo(218f, 312f); lineTo(294f, 312f); lineTo(294f, 426f) }
    drawPath(door, IntroBrand.sprout)
    drawPath(door, IntroBrand.canopy, style = Stroke(9f, join = StrokeJoin.Round))
    drawCircle(IntroBrand.terracottaDeep, radius = 6f, center = Offset(278f, 370f))
    // The shared threshold: the one warm accent on the page.
    drawLine(
        if (night) Color(0xFFDC6C1F) else IntroBrand.terracottaDeep,
        Offset(82f, 426f),
        Offset(430f, 426f),
        strokeWidth = 18f,
        cap = StrokeCap.Round,
    )
}

/** One plant: a stem from the soil line and two leaves, scaled up from the
 *  soil as `growth` goes from 0 to 1. */
private fun DrawScope.drawPlant(stemX: Float, top: Float, leaves: Path, fill: Color, growth: Float) {
    val g = growth.coerceAtLeast(0.001f)
    scale(g, g, pivot = Offset(stemX, 404f)) {
        drawPath(leaves, fill)
        val stem = Path().apply {
            moveTo(stemX, 404f); lineTo(stemX, top)
            addPath(leaves)
        }
        drawPath(stem, IntroBrand.canopy, style = Stroke(8f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

private fun leftLeaves() = Path().apply {
    moveTo(160f, 316f)
    cubicTo(127f, 314f, 109f, 295f, 106f, 265f)
    cubicTo(139f, 265f, 159f, 283f, 160f, 316f)
    close()
    moveTo(160f, 356f)
    cubicTo(197f, 354f, 218f, 334f, 222f, 299f)
    cubicTo(185f, 300f, 163f, 319f, 160f, 356f)
    close()
}

private fun rightLeaves() = Path().apply {
    moveTo(352f, 308f)
    cubicTo(385f, 306f, 403f, 287f, 406f, 257f)
    cubicTo(373f, 257f, 353f, 275f, 352f, 308f)
    close()
    moveTo(352f, 352f)
    cubicTo(315f, 350f, 294f, 330f, 290f, 295f)
    cubicTo(327f, 296f, 349f, 315f, 352f, 352f)
    close()
}
