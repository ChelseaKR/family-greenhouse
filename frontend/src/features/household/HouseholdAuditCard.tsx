/**
 * Household audit log (#675) — admin-only, on the household page.
 *
 * Who changed the household itself: members joining, leaving, being removed or
 * changing role; invitations; the sitter, wall-display, caretaker, plant-tag
 * and cutting links that open it to someone without an account; API keys; the
 * plan, and payments failing and recovering; restores and deletions from the
 * trash. Newest first, one page at a time.
 *
 * Read states are kept apart (ADR 0010). A failed first read is an error with
 * a retry, never "nothing recorded": an empty log tells an admin nobody has
 * touched their household's keys, which is the one thing this card must not
 * say falsely. A failed LATER page keeps what was already read and says the
 * older entries could not be loaded, rather than implying the list ends there.
 *
 * Nobody is named by anything but the server's answer: a current member by
 * display name, anyone who has left as a former member. An entry that follows
 * a failed audit write says so, so a dropped entry does not leave the log
 * looking continuous.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { formatDate, formatTime } from '@/i18n/format';
import { PLAN_PRICES } from '@/features/pricing/planPrices';
import {
  householdAuditService,
  type AuditParty,
  type HouseholdAuditEntry,
} from '@/services/householdAuditService';

/** Shown in copy written before any page has been read. Mirrors the server's
 *  AUDIT_RETENTION_DAYS; once a page arrives, its `retentionDays` wins. */
const DEFAULT_RETENTION_DAYS = 30;

function planName(plan: unknown): string {
  const id = typeof plan === 'string' ? plan : '';
  return PLAN_PRICES.find((p) => p.id === id)?.name ?? id;
}

function partyName(t: TFunction, party: AuditParty | null, position: 'subject' | 'object'): string {
  if (!party) return t('householdAudit.someone');
  if (party.type === 'member') return party.name;
  if (party.type === 'stripe') return t('householdAudit.stripe');
  return t(
    position === 'subject' ? 'householdAudit.formerMemberSubject' : 'householdAudit.formerMember'
  );
}

/** The entry as one sentence. Unknown kinds (a newer server) get a generic line. */
function describeAuditEntry(t: TFunction, entry: HouseholdAuditEntry): string {
  const actor = partyName(t, entry.actor, 'subject');
  const target = partyName(t, entry.target, 'object');
  const d = entry.details;
  const plan = planName(d.plan);
  const item = t(d.itemKind === 'task' ? 'householdAudit.itemTask' : 'householdAudit.itemPlant');
  switch (entry.kind) {
    case 'household.created':
      return t('householdAudit.kinds.householdCreated', { actor });
    case 'member.joined':
      return t('householdAudit.kinds.memberJoined', { actor });
    case 'member.left':
      return d.accountDeleted === true
        ? t('householdAudit.kinds.memberLeftAccountDeleted', { actor })
        : t('householdAudit.kinds.memberLeft', { actor });
    case 'member.removed':
      return t('householdAudit.kinds.memberRemoved', { actor, target });
    case 'member.role_changed':
      return t(
        d.to === 'admin'
          ? 'householdAudit.kinds.memberMadeAdmin'
          : 'householdAudit.kinds.memberMadeMember',
        { actor, target }
      );
    case 'invite.created':
      return t(
        d.channel === 'email'
          ? 'householdAudit.kinds.inviteEmailed'
          : 'householdAudit.kinds.inviteCreated',
        { actor }
      );
    case 'sitter_link.created':
      return t('householdAudit.kinds.sitterLinkCreated', { actor });
    case 'sitter_link.revoked':
      return t('householdAudit.kinds.sitterLinkRevoked', { actor });
    case 'kiosk_link.created':
      return t('householdAudit.kinds.kioskLinkCreated', { actor });
    case 'kiosk_link.revoked':
      return t('householdAudit.kinds.kioskLinkRevoked', { actor });
    case 'caretaker_seat.created':
      return t('householdAudit.kinds.caretakerSeatCreated', { actor });
    case 'caretaker_seat.revoked':
      return t('householdAudit.kinds.caretakerSeatRevoked', { actor });
    case 'plant_tag.created':
      return t('householdAudit.kinds.plantTagCreated', { actor });
    case 'plant_tag.revoked':
      return t('householdAudit.kinds.plantTagRevoked', { actor });
    case 'share_link.created':
      return t('householdAudit.kinds.shareLinkCreated', { actor });
    case 'api_key.created':
      return t('householdAudit.kinds.apiKeyCreated', { actor, last4: String(d.last4 ?? '') });
    case 'api_key.revoked':
      return t('householdAudit.kinds.apiKeyRevoked', { actor });
    case 'billing.plan_changed':
      if (d.via === 'gift') return t('householdAudit.kinds.planGift', { actor, plan });
      if (d.via === 'ended') return t('householdAudit.kinds.planEnded', { plan });
      if (d.status === 'trialing') return t('householdAudit.kinds.planTrialStarted', { plan });
      return t('householdAudit.kinds.planChanged', { plan });
    case 'billing.payment_failed':
      return t('householdAudit.kinds.paymentFailed', { plan });
    case 'billing.payment_recovered':
      return t('householdAudit.kinds.paymentRecovered', { plan });
    case 'trash.restored':
      return t('householdAudit.kinds.trashRestored', { actor, item });
    case 'trash.purged':
      return t('householdAudit.kinds.trashPurged', { actor, item });
    default:
      return t('householdAudit.kinds.unknown');
  }
}

/** The quieter second line, when an entry has one worth reading. */
function detailLine(t: TFunction, entry: HouseholdAuditEntry): string | null {
  const d = entry.details;
  const count = (key: string) => (typeof d[key] === 'number' ? (d[key] as number) : 0);
  if (entry.kind === 'member.removed' || entry.kind === 'member.left') {
    const revoked = ['sitterLinks', 'plantTags', 'kioskLinks', 'cuttingShares'].map(count);
    if (revoked.every((n) => n === 0)) return null;
    const [sitterLinks, plantTags, kioskLinks, cuttingShares] = revoked;
    return t('householdAudit.detail.revokedWith', {
      sitterLinks,
      plantTags,
      kioskLinks,
      cuttingShares,
    });
  }
  if (entry.kind === 'api_key.created' && typeof d.scopes === 'string') {
    return t('householdAudit.detail.scopes', { scopes: d.scopes.split(',').join(', ') });
  }
  if (typeof d.expiresAt === 'string') {
    return t('householdAudit.detail.expires', { date: formatDate(d.expiresAt) });
  }
  if (entry.kind === 'billing.plan_changed' && d.via === 'gift' && typeof d.endsAt === 'string') {
    return t('householdAudit.detail.giftEnds', { date: formatDate(d.endsAt) });
  }
  if (entry.actor.type === 'stripe') return t('householdAudit.detail.reportedByStripe');
  return null;
}

export function HouseholdAuditCard({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: ['household', householdId, 'audit'],
    queryFn: ({ pageParam }) => householdAuditService.list(householdId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const pages = query.data?.pages;
  const days = pages?.[0]?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const entries = pages?.flatMap((page) => page.items);

  return (
    <Card>
      <CardHeader
        title={t('householdAudit.title')}
        description={t('householdAudit.description', { days })}
      />

      {query.isPending ? (
        <div className="flex justify-center py-6">
          <LoadingSpinner />
        </div>
      ) : entries === undefined ? (
        <Alert variant="error">
          <p>{t('householdAudit.loadFailed')}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => query.refetch()}
            isLoading={query.isFetching}
          >
            {t('common.retry')}
          </Button>
        </Alert>
      ) : entries.length === 0 && !query.hasNextPage ? (
        <EmptyState
          title={t('householdAudit.emptyTitle')}
          description={t('householdAudit.emptyDescription', { days })}
        />
      ) : (
        <>
          <ol className="divide-y divide-primary-100/80" aria-label={t('householdAudit.listLabel')}>
            {entries.map((entry) => {
              const detail = detailLine(t, entry);
              return (
                <li key={entry.id} className="py-3">
                  {entry.gapBefore && (
                    <p className="mb-2 text-xs text-amber-900">{t('householdAudit.gap')}</p>
                  )}
                  <p className="text-sm text-ink break-words">{describeAuditEntry(t, entry)}</p>
                  <p className="mt-0.5 text-xs text-gray-600">
                    <time dateTime={entry.occurredAt}>
                      {t('householdAudit.when', {
                        date: formatDate(entry.occurredAt),
                        time: formatTime(entry.occurredAt),
                      })}
                    </time>
                    {detail && <span> · {detail}</span>}
                  </p>
                </li>
              );
            })}
          </ol>

          {query.isFetchNextPageError && (
            <Alert variant="error" className="mt-3">
              {t('householdAudit.loadMoreFailed')}
            </Alert>
          )}
          {query.hasNextPage ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => query.fetchNextPage()}
              isLoading={query.isFetchingNextPage}
            >
              {t('householdAudit.loadMore')}
            </Button>
          ) : (
            <p className="mt-3 text-xs text-gray-600">{t('householdAudit.end', { days })}</p>
          )}
        </>
      )}
    </Card>
  );
}
