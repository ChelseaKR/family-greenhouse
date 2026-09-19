import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CameraIcon, PhotoIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/Button';
import {
  nativePhotoErrorMessage,
  pickNativePhoto,
  type PhotoSource,
} from '@/services/nativeCamera';

interface NativePhotoButtonsProps {
  /** Called with the photo the person took or picked. Not called on cancel. */
  onPick: (file: File) => void;
  /** Called with a message ready to show when the camera or picker failed. */
  onError: (message: string) => void;
  disabled?: boolean;
}

/**
 * "Take photo" and "Choose photo", for the native shells only. The caller
 * renders this in place of its `<input type="file">` when
 * `canUseNativeCamera()` is true, and keeps the input on the web.
 *
 * Permission is asked by the OS the first time the person taps one of these
 * buttons, never before, and the picker needs none at all on Android.
 */
export function NativePhotoButtons({ onPick, onError, disabled }: NativePhotoButtonsProps) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState<PhotoSource | null>(null);

  async function open(source: PhotoSource) {
    setOpening(source);
    try {
      const file = await pickNativePhoto(source);
      if (file) onPick(file);
    } catch (error) {
      onError(nativePhotoErrorMessage(error, t));
    } finally {
      setOpening(null);
    }
  }

  // Side by side only when both labels fit, stacked otherwise. This was a
  // two-column grid, and a grid's columns shrink below their content: in the
  // 192px photo column of the plant page at iPad widths, and beside the
  // 128px preview on Add plant, each column was narrower than its no-wrap
  // label, so "Take photo" ran over the camera icon of "Choose photo". A
  // wrapping row lets the labels decide instead, at any width and text size.
  // Each button grows to fill its row. From the accessibility text sizes up
  // they always stack. Held by tests/e2e/native-photo-buttons.spec.ts.
  return (
    <div className="flex flex-wrap gap-2 large-text:flex-col" data-testid="native-photo-buttons">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="grow"
        isLoading={opening === 'camera'}
        disabled={disabled || opening !== null}
        onClick={() => void open('camera')}
        leftIcon={<CameraIcon className="h-4 w-4" aria-hidden="true" />}
      >
        {t('plants.photoPicker.take')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="grow"
        isLoading={opening === 'library'}
        disabled={disabled || opening !== null}
        onClick={() => void open('library')}
        leftIcon={<PhotoIcon className="h-4 w-4" aria-hidden="true" />}
      >
        {t('plants.photoPicker.choose')}
      </Button>
    </div>
  );
}
