import { useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { connectionStoreFor } from '@/services/connectionStatus';

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/**
 * Says so when what's on screen may not be current (services/
 * connectionStatus.ts): offline, or online but unable to reach the API. It
 * says how old the screen is and what happens to a change made now, instead
 * of leaving loaded data to read as live. It renders nothing while every
 * read is getting answers.
 */
export function ConnectionNotice() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const store = connectionStoreFor(queryClient);
  const { online, reachable, lastSyncedAt } = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState
  );

  if (online && reachable) return null;

  let synced = t('connection.neverSynced');
  if (lastSyncedAt !== null) {
    const at = new Date(lastSyncedAt);
    synced = sameDay(at, new Date())
      ? t('connection.lastSyncedAt', {
          time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(at),
        })
      : t('connection.lastSyncedOn', {
          date: new Intl.DateTimeFormat(i18n.language, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(at),
        });
  }

  return (
    <Alert
      variant="warning"
      title={online ? t('connection.unreachableTitle') : t('connection.offlineTitle')}
      className="mb-6"
    >
      <div className="space-y-2 text-sm" data-testid="connection-notice">
        <p>{synced}</p>
        <p>{online ? t('connection.unreachableChanges') : t('connection.offlineChanges')}</p>
        {online && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void queryClient.invalidateQueries({ refetchType: 'active' })}
          >
            {t('common.retry')}
          </Button>
        )}
      </div>
    </Alert>
  );
}
