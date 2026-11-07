import UIKit
import StoreKit
import Capacitor

/// Apple In-App Purchase with StoreKit 2 (ADR 0041).
///
/// The web side decides everything about money: whether purchases are on at
/// all (`VITE_APP_STORE_PURCHASES`), which product a household may buy (the
/// server's purchase intent refuses a home that already pays through another
/// route), and whether a transaction counts (the server verifies Apple's
/// signature before it records anything). This plugin only talks to StoreKit:
///
/// - `getProducts`: the App Store's own localized names and prices. The app
///   shows these and no other price.
/// - `purchase`: Apple's purchase sheet, with the household's
///   `appAccountToken` stamped into the transaction.
/// - `currentEntitlements` / `restore`: the signed transactions this Apple ID
///   holds now; `restore` first asks the App Store to sync (the explicit
///   "Restore purchases" tap Apple requires).
/// - `finish`: marks a transaction finished, only after the server accepted
///   it. Until then StoreKit redelivers it through `Transaction.updates`.
/// - `manageSubscriptions`: Apple's Manage Subscriptions sheet (upgrade,
///   downgrade, cancel), so the app never builds its own.
///
/// It also listens to `Transaction.updates` from launch (renewals, refunds,
/// Ask to Buy approvals, purchases finished while the app was closed) and
/// passes each one to the web as a `transaction` event, retained until the
/// web listens.
///
/// It lives in the app target rather than an npm package, like
/// NativeReviewPlugin, and MainViewController registers it.
@objc(NativePurchasesPlugin)
public class NativePurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePurchasesPlugin"
    public let jsName = "NativePurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise),
    ]

    private var updatesTask: Task<Void, Never>?

    override public func load() {
        updatesTask = Task.detached(priority: .background) { [weak self] in
            for await result in Transaction.updates {
                guard let self = self else { return }
                if case .verified = result {
                    let payload = await NativePurchasesPlugin.payload(for: result)
                    self.notifyListeners("transaction", data: payload, retainUntilConsumed: true)
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    /// `{ products: [{ id, displayName, description, displayPrice, price, currencyCode, period }] }`
    @objc func getProducts(_ call: CAPPluginCall) {
        let ids = call.getArray("productIds", String.self) ?? []
        Task {
            do {
                let products = try await Product.products(for: ids)
                call.resolve(["products": products.map(NativePurchasesPlugin.describe)])
            } catch {
                call.reject("Could not load products", "PRODUCTS_FAILED", error)
            }
        }
    }

    /// `{ status: 'purchased' | 'pending' | 'cancelled', signedTransaction?, transactionId?, signedRenewalInfo? }`
    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else {
            call.reject("productId is required", "INVALID")
            return
        }
        guard let tokenString = call.getString("appAccountToken"),
              let token = UUID(uuidString: tokenString) else {
            call.reject("appAccountToken must be a UUID", "INVALID")
            return
        }
        Task { @MainActor in
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("Product not found", "PRODUCT_NOT_FOUND")
                    return
                }
                let options: Set<Product.PurchaseOption> = [.appAccountToken(token)]
                let result: Product.PurchaseResult
                if #available(iOS 17.0, *),
                   let scene = self.bridge?.webView?.window?.windowScene {
                    result = try await product.purchase(confirmIn: scene, options: options)
                } else {
                    result = try await product.purchase(options: options)
                }
                switch result {
                case .success(let verification):
                    guard case .verified = verification else {
                        call.reject("The App Store could not verify the purchase", "UNVERIFIED")
                        return
                    }
                    var payload = await NativePurchasesPlugin.payload(for: verification)
                    payload["status"] = "purchased"
                    call.resolve(payload)
                case .pending:
                    // Ask to Buy, or a payment that needs action: it arrives
                    // later through Transaction.updates.
                    call.resolve(["status": "pending"])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.resolve(["status": "cancelled"])
                }
            } catch {
                // On the iOS 26.5 simulator, StoreKit Testing can fail here
                // with SKInternalErrorDomain Code=3 (an Apple bug, see
                // docs/mobile.md "In-App Purchase"). It is reported, not
                // retried.
                call.reject(error.localizedDescription, "PURCHASE_FAILED", error)
            }
        }
    }

    /// `{ transactions: [{ signedTransaction, transactionId, signedRenewalInfo? }] }`
    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task {
            call.resolve(["transactions": await NativePurchasesPlugin.entitlements()])
        }
    }

    /// Same shape as `currentEntitlements`, after `AppStore.sync()`. Apple
    /// may ask the person to sign in, so call it only from a tap.
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
            } catch {
                call.reject(error.localizedDescription, "RESTORE_FAILED", error)
                return
            }
            call.resolve(["transactions": await NativePurchasesPlugin.entitlements()])
        }
    }

    /// `{ finished }`: true when an unfinished transaction with that id was found and finished.
    @objc func finish(_ call: CAPPluginCall) {
        guard let idString = call.getString("transactionId"), let id = UInt64(idString) else {
            call.reject("transactionId is required", "INVALID")
            return
        }
        Task {
            for await result in Transaction.unfinished {
                if case .verified(let transaction) = result, transaction.id == id {
                    await transaction.finish()
                    call.resolve(["finished": true])
                    return
                }
            }
            call.resolve(["finished": false])
        }
    }

    /// `{ shown }`
    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = self.bridge?.webView?.window?.windowScene else {
                call.resolve(["shown": false])
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve(["shown": true])
            } catch {
                call.reject(error.localizedDescription, "MANAGE_FAILED", error)
            }
        }
    }

    // MARK: - Shapes

    private static func describe(_ product: Product) -> [String: Any] {
        var out: [String: Any] = [
            "id": product.id,
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice,
            "price": NSDecimalNumber(decimal: product.price).stringValue,
            "currencyCode": product.priceFormatStyle.currencyCode,
        ]
        if let period = product.subscription?.subscriptionPeriod {
            let unit: String
            switch period.unit {
            case .day: unit = "day"
            case .week: unit = "week"
            case .month: unit = "month"
            case .year: unit = "year"
            @unknown default: unit = "unknown"
            }
            out["period"] = ["unit": unit, "value": period.value]
        }
        return out
    }

    private static func payload(for result: VerificationResult<Transaction>) async -> [String: Any] {
        var out: [String: Any] = ["signedTransaction": result.jwsRepresentation]
        if case .verified(let transaction) = result {
            out["transactionId"] = String(transaction.id)
            if #available(iOS 17.2, *),
               let status = await transaction.subscriptionStatus,
               case .verified = status.renewalInfo {
                out["signedRenewalInfo"] = status.renewalInfo.jwsRepresentation
            }
        }
        return out
    }

    private static func entitlements() async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  transaction.productType == .autoRenewable else { continue }
            out.append(await payload(for: result))
        }
        return out
    }
}
