import { useRef, useState } from 'react';

const LONG_PRESS_MS = 500;

interface RowGestureOptions {
  /** No gestures at all (a plain row). */
  enabled: boolean;
  /** Width of the actions revealed by swiping right (0: none). */
  leadingWidth: number;
  /** Width of the actions revealed by swiping left (0: none). */
  trailingWidth: number;
  /** A swipe right past half the row: the leading action at once. */
  onFullLeading?: () => void;
  /** A long press on a touchscreen. */
  onLongPress: (row: HTMLElement | null) => void;
}

/**
 * Swipe and long press for a list row, as in Mail and Reminders: swipe right
 * to reveal the leading action (all the way across does it at once), swipe
 * left to reveal the trailing actions, long press for the row's menu. Touch
 * only; a mouse or a keyboard uses the row's own controls.
 *
 * Returns the offset to translate the row by, and the handlers to put on it.
 */
export function useRowGestures({
  enabled,
  leadingWidth,
  trailingWidth,
  onFullLeading,
  onLongPress,
}: RowGestureOptions) {
  const [offset, setOffsetState] = useState(0);
  // The offset as of the last event, for the release: a fast swipe can end
  // before React re-renders, so the state in this render may be stale.
  const offsetRef = useRef(0);
  const setOffset = (value: number) => {
    offsetRef.current = value;
    setOffsetState(value);
  };
  const [dragging, setDragging] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    start: number;
    horizontal: boolean | null;
    pressTimer: ReturnType<typeof setTimeout> | null;
    pressed: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const close = () => setOffset(0);
  const clearPress = () => {
    const g = gesture.current;
    if (g?.pressTimer) clearTimeout(g.pressTimer);
    if (g) g.pressTimer = null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    // A new gesture: a click it produces is its own, never one to swallow
    // for an earlier long press.
    suppressClick.current = false;
    if (!enabled || event.pointerType !== 'touch') return;
    const g = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: offsetRef.current,
      horizontal: null as boolean | null,
      pressTimer: null as ReturnType<typeof setTimeout> | null,
      pressed: false,
    };
    g.pressTimer = setTimeout(() => {
      g.pressed = true;
      suppressClick.current = true;
      onLongPress(rowRef.current);
    }, LONG_PRESS_MS);
    gesture.current = g;
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId || g.pressed) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearPress();
    if (g.horizontal === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      g.horizontal = Math.abs(dx) > Math.abs(dy);
      if (g.horizontal) {
        try {
          (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        } catch {
          // No such active pointer (a synthetic event): moves still arrive.
        }
        setDragging(true);
      }
    }
    if (!g.horizontal) return;
    const width = rowRef.current?.offsetWidth || 360;
    const max = leadingWidth > 0 ? (onFullLeading ? width * 0.8 : leadingWidth) : 0;
    setOffset(Math.max(-trailingWidth, Math.min(max, g.start + dx)));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const g = gesture.current;
    clearPress();
    gesture.current = null;
    if (!g || g.id !== event.pointerId) return;
    if (g.pressed) {
      // iOS sends no click after a long press. Forget the swallow once the
      // click that might follow has had its chance, or the next activation
      // (a keyboard Enter, a VoiceOver double-tap, which bring no pointer
      // down) would be eaten.
      setTimeout(() => {
        suppressClick.current = false;
      }, 400);
      return;
    }
    if (!g.horizontal) return;
    suppressClick.current = true;
    setDragging(false);
    const width = rowRef.current?.offsetWidth || 360;
    const now = offsetRef.current;
    if (onFullLeading && leadingWidth > 0 && now > width * 0.5) {
      close();
      onFullLeading(); // a swipe right across: the leading action at once
    } else if (leadingWidth > 0 && now > leadingWidth / 2) {
      setOffset(leadingWidth);
    } else if (trailingWidth > 0 && now < -Math.min(trailingWidth, 88) / 2) {
      setOffset(-trailingWidth);
    } else {
      close();
    }
  };

  const onClickCapture = (event: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (offsetRef.current !== 0) {
      // A tap on an open row closes it rather than opening what it links to.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return {
    offset,
    dragging,
    rowRef,
    close,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClickCapture,
    },
  };
}
