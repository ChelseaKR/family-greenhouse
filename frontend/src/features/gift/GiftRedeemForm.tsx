import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { formatDate } from '@/i18n/format';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { billingService, type Plan, type PlanId } from '@/services/billingService';
import { clearPendingGiftCode } from './pendingGiftCode';

type GiftablePlanId = Exclude<PlanId, 'seedling'>;

const REDEEM_ERROR_CODES = new Set([
  'GIFT_CODE_INVALID',
  'GIFT_CODE_REDEEMED',
  'GIFT_HOUSEHOLD_SUBSCRIBED',
  'GIFT_ALREADY_ACTIVE',
  'GIFT_ADDS_NOTHING',
  'GIFT_REDEEM_CONFLICT',
]);

interface ApiErrorShape {
  response?: {
    status?: number;
    data?: { details?: { code?: unknown; endsAt?: unknown } };
  };
}

/**
 * Map a redemption refusal onto the sentence for it. The server's
 * `details.code` is the contract; a status without one is either the rate
 * limit or something we cannot name, and gets the honest generic line.
 */
function redeemError(error: unknown): { key: string; date?: string } {
  const response = (error as ApiErrorShape)?.response;
  const code = response?.data?.details?.code;
  if (typeof code === 'string' && REDEEM_ERROR_CODES.has(code)) {
    const raw = response?.data?.details?.endsAt;
    return {
      key: `giftSubscription.errors.${code}`,
      date: typeof raw === 'string' ? raw : undefined,
    };
  }
  if (response?.status === 429) return { key: 'giftSubscription.errors.rateLimited' };
  if (response?.status === 403) return { key: 'giftSubscription.redeemAdminOnly' };
  return { key: 'giftSubscription.errors.generic' };
}

function planName(plans: Plan[] | undefined, id: GiftablePlanId): string {
  return plans?.find((p) => p.id === id)?.name ?? id;
}

/**
 * The redeem-a-code form (ADR 0028), for a household admin. Used on the
 * public /redeem page, where a code from a shared link arrives filled in, and
 * on Settings → Billing. A successful redemption clears any code carried
 * through sign-up (`pendingGiftCode`) and re-reads the household's plan.
 */
export function GiftRedeemForm({
  plans,
  initialCode = '',
  idPrefix = 'gift',
}: {
  plans: Plan[] | undefined;
  initialCode?: string;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(initialCode);
  const [errorState, setError] = useState<{ key: string; date?: string } | null>(null);
  const [redeemed, setRedeemed] = useState<{ planId: GiftablePlanId; endsAt: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () => billingService.redeemGiftCode({ code }),
    onMutate: () => {
      setError(null);
      setRedeemed(null);
    },
    onSuccess: (result) => {
      setRedeemed(result);
      setCode('');
      clearPendingGiftCode();
      // Entitlement changed behind every plan-aware card: re-read it.
      void queryClient.invalidateQueries({ queryKey: ['subscription', householdId] });
    },
    onError: (error) => setError(redeemError(error)),
  });

  return (
    <div>
      {errorState && (
        <Alert variant="error" title={t('giftSubscription.errorTitle')} className="mt-2">
          <p>{t(errorState.key, { date: errorState.date ? formatDate(errorState.date) : '' })}</p>
        </Alert>
      )}
      {redeemed && (
        <div data-testid="gift-redeemed">
          <Alert variant="success" className="mt-2">
            <p>
              {t('giftSubscription.redeemed', {
                plan: planName(plans, redeemed.planId),
                date: formatDate(redeemed.endsAt),
              })}
            </p>
          </Alert>
        </div>
      )}
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() !== '') mutation.mutate();
        }}
      >
        <div className="min-w-[16rem] grow">
          <Input
            id={`${idPrefix}-code`}
            label={t('giftSubscription.codeInputLabel')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t('giftSubscription.codePlaceholder')}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>
        <Button
          type="submit"
          isLoading={mutation.isPending}
          disabled={code.trim() === '' || mutation.isPending}
        >
          {t('giftSubscription.redeem')}
        </Button>
      </form>
    </div>
  );
}
