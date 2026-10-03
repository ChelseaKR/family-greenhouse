import { useEffect, useRef } from 'react';
import type { NativeBarTools } from '@/config/nativeBarTools';
import { loadNativeChrome } from '@/services/loadNativeChrome';

/**
 * Puts a screen's menus and search into the iOS app's navigation bar, and
 * routes what is picked or typed back to the page. Pass `null` when the bar
 * should not carry them (the website, or an app built before `setBarTools`).
 *
 * The plugin is imported lazily, here, so the website never downloads it.
 * Repeated sends of the same tools are skipped, so a re-render that changes
 * nothing does not rebuild the native menus.
 */
export function useNativeBarTools(
  tools: NativeBarTools | null,
  onSelect: (id: string) => void,
  onSearch: (text: string) => void
): void {
  const handlers = useRef({ onSelect, onSearch });
  handlers.current = { onSelect, onSearch };
  const path = tools?.path ?? null;
  const message = tools ? JSON.stringify(tools) : '';

  useEffect(() => {
    if (!path) return;
    let removed = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    void loadNativeChrome().then(({ NativeChrome }) => {
      if (removed) return;
      const add = [
        NativeChrome.addListener('barMenuSelect', (event) => {
          if (event.path === path) handlers.current.onSelect(event.id);
        }),
        NativeChrome.addListener('barSearch', (event) => {
          if (event.path === path) handlers.current.onSearch(event.text);
        }),
      ];
      for (const pending of add) {
        void pending.then((handle) => {
          if (removed) void handle.remove();
          else handles.push(handle);
        });
      }
    });
    return () => {
      removed = true;
      for (const handle of handles) void handle.remove().catch(() => undefined);
    };
  }, [path]);

  useEffect(() => {
    if (!message) return;
    void loadNativeChrome().then(({ NativeChrome }) =>
      NativeChrome.setBarTools(JSON.parse(message) as NativeBarTools).catch(() => undefined)
    );
  }, [message]);
}
