import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { NATIVE_CHROME_PLUGIN } from '@/lib/platform';
import type {
  NativeChromeConfiguration,
  NativeChromeEvents,
  NativeChromeUpdate,
} from '@/config/nativeFrame';
import type { NativeBarTools, NativeBarToolsEvents } from '@/config/nativeBarTools';
import type {
  NativePresentRequest,
  NativePresentResult,
  NativePresentUpdate,
} from '@/config/nativePresent';

/**
 * The iOS app's NativeChrome plugin (ios/App/App/NativeChromePlugin.swift),
 * registered once. Imported only by native-only lazy chunks
 * (NativeFrameBridge.tsx, native/NativePresenter.tsx), never by the website.
 *
 * - The frame: `configure`, `update`, and four events (config/nativeFrame.ts).
 * - Alerts and action sheets: `present`, `updatePresented`,
 *   `dismissPresented` (config/nativePresent.ts).
 * - A screen's menus and search in the bar: `setBarTools`, and the
 *   `barMenuSelect` / `barSearch` events (config/nativeBarTools.ts).
 */
export interface NativeChromePlugin {
  configure(options: NativeChromeConfiguration): Promise<void>;
  update(options: NativeChromeUpdate): Promise<void>;
  present(options: NativePresentRequest): Promise<NativePresentResult>;
  updatePresented(options: NativePresentUpdate): Promise<void>;
  dismissPresented(options: { token: string }): Promise<void>;
  setBarTools(options: NativeBarTools): Promise<void>;
  addListener<E extends keyof (NativeChromeEvents & NativeBarToolsEvents)>(
    eventName: E,
    listener: (event: (NativeChromeEvents & NativeBarToolsEvents)[E]) => void
  ): Promise<PluginListenerHandle>;
}

export const NativeChrome = registerPlugin<NativeChromePlugin>(NATIVE_CHROME_PLUGIN);
