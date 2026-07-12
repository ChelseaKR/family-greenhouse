import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FlagIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { chatService, type ChatReportReason } from '@/services/chatService';
import { getErrorMessage } from '@/services/api';

const REPORT_REASONS: ChatReportReason[] = ['incorrect', 'unsafe', 'offensive', 'other'];

export function ReportResponseControl({
  conversationId,
  responseText,
}: {
  conversationId: string;
  responseText: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ChatReportReason>('incorrect');
  const [details, setDetails] = useState('');
  const report = useMutation({
    mutationFn: () =>
      chatService.reportResponse({
        conversationId,
        responseText: responseText.slice(0, 8000),
        reason,
        details: details.trim() || undefined,
      }),
  });

  if (report.isSuccess) {
    return (
      <p className="mt-1.5 text-xs text-primary-700" role="status">
        {t('chat.report.success')}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1.5 inline-flex min-h-touch items-center gap-1.5 rounded-md px-1 text-xs text-gray-600 underline-offset-2 hover:text-primary-800 hover:underline"
        onClick={() => setOpen(true)}
      >
        <FlagIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {t('chat.report.open')}
      </button>
    );
  }

  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-primary-100 bg-white p-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        report.mutate();
      }}
    >
      <label className="block text-xs font-medium text-gray-800">
        {t('chat.report.reason')}
        <select
          className="input mt-1 py-2 text-sm"
          value={reason}
          onChange={(event) => setReason(event.target.value as ChatReportReason)}
        >
          {REPORT_REASONS.map((option) => (
            <option key={option} value={option}>
              {t(`chat.report.reasons.${option}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium text-gray-800">
        {t('chat.report.details')}
        <textarea
          className="input mt-1 min-h-20 resize-y text-sm"
          maxLength={1000}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
        />
      </label>
      {report.isError && (
        <p className="text-xs text-red-700" role="alert">
          {getErrorMessage(report.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="min-h-touch rounded-md bg-primary-700 px-3 py-1.5 text-xs font-medium text-white disabled:bg-primary-200"
          disabled={report.isPending}
        >
          {report.isPending ? t('chat.report.sending') : t('chat.report.submit')}
        </button>
        <button
          type="button"
          className="min-h-touch rounded-md px-3 py-1.5 text-xs text-gray-700"
          onClick={() => setOpen(false)}
          disabled={report.isPending}
        >
          {t('chat.report.cancel')}
        </button>
      </div>
    </form>
  );
}
