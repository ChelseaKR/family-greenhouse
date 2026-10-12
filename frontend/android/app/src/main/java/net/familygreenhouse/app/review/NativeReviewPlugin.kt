package net.familygreenhouse.app.review

import androidx.lifecycle.Lifecycle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.play.core.review.ReviewManagerFactory

/**
 * Asks Google Play for its in-app review card (ADR 0036). The Android half of
 * ios/App/App/NativeReviewPlugin.swift, with the same name, method and answer.
 *
 * The web decides when (frontend/src/lib/reviewPromptState.ts: after care was
 * marked done a few times, never on a first launch or a setup screen, once
 * per version and 120 days apart) and calls `requestReview`. This plugin only
 * hands the request to Play's In-App Review API. Play decides whether the
 * card appears: it has its own quota, shows nothing to an app that was not
 * installed from Play, and never says whether the person rated.
 *
 * It carries no words and offers nothing: the card is Google's own, the same
 * for everyone (Play's policy, like App Review Guideline 5.6.1, forbids
 * asking first or rewarding a rating).
 *
 * Resolves `{ requested }`: true when Play was handed the request and ran its
 * flow, false when the app was not in the foreground or Play could not start
 * one (no Play Store, an emulator without it). The web counts only `true` as
 * an ask. MainActivity registers it.
 */
@CapacitorPlugin(name = "NativeReview")
class NativeReviewPlugin : Plugin() {
    @PluginMethod
    fun requestReview(call: PluginCall) {
        bridge.executeOnMainThread {
            val activity = activity
            if (activity == null || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                call.resolve(JSObject().put("requested", false))
                return@executeOnMainThread
            }
            val manager = ReviewManagerFactory.create(activity)
            manager.requestReviewFlow().addOnCompleteListener { request ->
                if (!request.isSuccessful || activity.isFinishing) {
                    call.resolve(JSObject().put("requested", false))
                    return@addOnCompleteListener
                }
                manager.launchReviewFlow(activity, request.result).addOnCompleteListener { launched ->
                    call.resolve(JSObject().put("requested", launched.isSuccessful))
                }
            }
        }
    }
}
