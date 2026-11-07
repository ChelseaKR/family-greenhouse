import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { NATIVE_PURCHASES_PLUGIN } from '@/services/appStoreAvailability';

/**
 * The iOS app's NativePurchases plugin (ios/App/App/NativePurchasesPlugin.swift,
 * ADR 0041), registered once. Loaded with a dynamic import and only behind
 * `appStorePurchasesAvailable()`, so the website never downloads it or
 * `@capacitor/core` through it. Never resolve a promise with the plugin
 * itself: it is a proxy that answers every property, `then` included
 * (services/loadNativeChrome.ts).
 */
export interface StoreProduct {
  id: string;
  displayName: string;
  description: string;
  /** Apple's localized price string, for example "$4.99". The only price the app shows. */
  displayPrice: string;
  price: string;
  currencyCode?: string;
  period?: { unit: 'day' | 'week' | 'month' | 'year' | 'unknown'; value: number };
}

export interface SignedTransaction {
  signedTransaction: string;
  transactionId?: string;
  signedRenewalInfo?: string;
}

export type PurchaseResult =
  ({ status: 'purchased' } & SignedTransaction) | { status: 'pending' } | { status: 'cancelled' };

interface NativePurchasesPlugin {
  getProducts(options: { productIds: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(options: { productId: string; appAccountToken: string }): Promise<PurchaseResult>;
  currentEntitlements(): Promise<{ transactions: SignedTransaction[] }>;
  restore(): Promise<{ transactions: SignedTransaction[] }>;
  finish(options: { transactionId: string }): Promise<{ finished: boolean }>;
  manageSubscriptions(): Promise<{ shown: boolean }>;
  addListener(
    event: 'transaction',
    listener: (update: SignedTransaction) => void
  ): Promise<PluginListenerHandle>;
}

const NativePurchases = registerPlugin<NativePurchasesPlugin>(NATIVE_PURCHASES_PLUGIN);

export async function getProducts(productIds: string[]): Promise<StoreProduct[]> {
  const result = await NativePurchases.getProducts({ productIds });
  return Array.isArray(result?.products) ? result.products : [];
}

export async function purchase(
  productId: string,
  appAccountToken: string
): Promise<PurchaseResult> {
  return NativePurchases.purchase({ productId, appAccountToken });
}

export async function currentEntitlements(): Promise<SignedTransaction[]> {
  const result = await NativePurchases.currentEntitlements();
  return Array.isArray(result?.transactions) ? result.transactions : [];
}

export async function restore(): Promise<SignedTransaction[]> {
  const result = await NativePurchases.restore();
  return Array.isArray(result?.transactions) ? result.transactions : [];
}

export async function finish(transactionId: string): Promise<boolean> {
  try {
    const result = await NativePurchases.finish({ transactionId });
    return result?.finished === true;
  } catch {
    return false;
  }
}

export async function manageSubscriptions(): Promise<boolean> {
  const result = await NativePurchases.manageSubscriptions();
  return result?.shown === true;
}

export async function onTransaction(
  listener: (update: SignedTransaction) => void
): Promise<() => void> {
  const handle = await NativePurchases.addListener('transaction', listener);
  return () => {
    void handle.remove();
  };
}
