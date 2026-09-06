import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CameraIcon } from '@heroicons/react/24/outline';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { prepareSitterPhoto } from './sitterPhotoPrep';
import { SitterLinkInactiveError, type SitterTask } from '@/services/sitterService';
import {
  SitterPhotoRefusedError,
  sitterPhotoService,
  type SitterPhotoStatus,
} from '@/services/sitterPhotoService';

/**
 * Sitter photo-back (Away Kit): the no-account visitor sends a photo of a
 * plant back to the household so they can see how things are going.
 *
 * The server is the authority on every limit — 300 KB per file, 60 per link,
 * image type by magic bytes, rate limits, and the link's own window. The
 * downscale here is a courtesy to the sitter's data plan, not a guard, and
 * every refusal the server returns is shown verbatim rather than swallowed.
 *
 * Read discipline: a FAILED status read is not "photo-back is off". The
 * panel still renders (the server will answer authoritatively on upload) and
 * says the remaining count is unknown, rather than showing "0 of 60 used" or
 * silently disappearing.
 */

interface SitterPhotoBackProps {
  token: string;
  tasks: SitterTask[];
  /** Called when the link turns out to be closed, so the page can show its
   *  single "no longer active" screen instead of a stuck panel. */
  onLinkInactive: () => void;
}

export function SitterPhotoBack({ token, tasks, onLinkInactive }: SitterPhotoBackProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<SitterPhotoStatus | null>(null);
  const [statusUnknown, setStatusUnknown] = useState(false);
  const [statusSettled, setStatusSettled] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [caption, setCaption] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    sitterPhotoService
      .getStatus(token, controller.signal)
      .then((next) => {
        setStatus(next);
        setStatusUnknown(false);
        setStatusSettled(true);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof SitterLinkInactiveError) {
          onLinkInactive();
          return;
        }
        // Unknown, not "off": the panel stays, the count does not pretend.
        setStatus(null);
        setStatusUnknown(true);
        setStatusSettled(true);
      });
    return () => controller.abort();
  }, [token, onLinkInactive]);

  const handleFilePick = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setError(t('sitter.photo.notAnImage'));
        return;
      }
      setBusy(true);
      try {
        const prepared = await prepareSitterPhoto(file);
        if (!prepared) {
          setError(t('sitter.photo.tooLarge'));
          return;
        }
        setPreview(prepared);
      } catch {
        setError(t('sitter.photo.readFailed'));
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  const handleSend = useCallback(async () => {
    if (!preview || !taskId) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await sitterPhotoService.upload(token, {
        taskId,
        image: preview,
        caption: caption.trim() || undefined,
      });
      setSentCount((n) => n + 1);
      setStatus((current) =>
        current ? { ...current, used: receipt.used, remaining: receipt.remaining } : current
      );
      setPreview(null);
      setCaption('');
    } catch (err) {
      if (err instanceof SitterLinkInactiveError) {
        onLinkInactive();
        return;
      }
      setError(err instanceof SitterPhotoRefusedError ? err.message : t('sitter.photo.sendFailed'));
    } finally {
      setBusy(false);
    }
  }, [caption, onLinkInactive, preview, t, taskId, token]);

  // Only a settled "the plan does not include this" hides the panel. A read
  // that never settled, or one that failed, leaves it up.
  if (!statusSettled) return null;
  if (status && !status.enabled) return null;
  if (tasks.length === 0) return null;

  const remaining = status?.remaining ?? null;

  return (
    <section
      className="mt-10 rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal"
      aria-labelledby="sitter-photo-heading"
    >
      <h2 id="sitter-photo-heading" className="font-medium text-gray-900">
        {t('sitter.photo.heading')}
      </h2>
      <p className="mt-1 text-sm text-gray-600">{t('sitter.photo.body')}</p>
      <p className="mt-1 text-xs text-gray-600">
        {statusUnknown
          ? t('sitter.photo.remainingUnknown')
          : remaining === null
            ? t('sitter.photo.remainingUnknown')
            : t('sitter.photo.remaining', { count: remaining })}
      </p>

      <div className="mt-4 space-y-3">
        <label className="block text-sm font-medium text-gray-900" htmlFor="sitter-photo-task">
          {t('sitter.photo.whichPlant')}
        </label>
        <select
          id="sitter-photo-task"
          className="input w-full"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
        >
          <option value="">{t('sitter.photo.choosePlant')}</option>
          {tasks.map((task) => (
            <option key={task.taskId} value={task.taskId}>
              {task.plantName}
            </option>
          ))}
        </select>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFilePick}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            leftIcon={<CameraIcon className="h-4 w-4" aria-hidden="true" />}
          >
            {t('sitter.photo.choosePhoto')}
          </Button>
          {preview && (
            <img
              src={preview}
              alt={t('sitter.photo.previewAlt')}
              className="h-16 w-16 rounded-md object-cover bg-parchment"
            />
          )}
        </div>

        <label className="block text-sm font-medium text-gray-900" htmlFor="sitter-photo-caption">
          {t('sitter.photo.captionLabel')}
        </label>
        <input
          id="sitter-photo-caption"
          type="text"
          className="input w-full"
          maxLength={200}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
        />

        <Button
          variant="primary"
          size="sm"
          isLoading={busy}
          disabled={!preview || !taskId}
          onClick={handleSend}
        >
          {t('sitter.photo.send')}
        </Button>
      </div>

      {/* No aria-live on this wrapper: it contains nothing but Alerts, and
          each Alert is already a live region with the right politeness for its
          variant. Declaring one here made the success Alert's own
          role="status" a nested polite region (announced twice) and put the
          error's role="alert" — assertive — inside a polite parent, which is
          the case Alert's own docs warn about. Dropping the attribute keeps
          the failed send assertive, which is what it should be. */}
      <div>
        {sentCount > 0 && !error && (
          <Alert variant="success" className="mt-3">
            {t('sitter.photo.sent', { count: sentCount })}
          </Alert>
        )}
        {error && (
          <Alert variant="error" className="mt-3">
            {error}
          </Alert>
        )}
      </div>
    </section>
  );
}
