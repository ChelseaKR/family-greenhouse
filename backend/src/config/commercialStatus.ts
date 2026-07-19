import status from '../../../commercial-status.json' with { type: 'json' };

/**
 * Repository-wide commercial status. The JSON file is imported by both the
 * backend and frontend so changing the hold requires one explicit,
 * review-visible source change.
 */
export const COMMERCIAL_HOLD_ACTIVE = status.commercialHoldActive === true;
export const COMMERCIAL_HOLD_EFFECTIVE_DATE = status.effectiveDate;
export const COMMERCIAL_HOLD_MESSAGE = status.publicMessage;

/** Public self-registration is fail-closed and requires an exact boolean true. */
export function isPublicRegistrationAllowed(publicRegistrationAvailable: unknown): boolean {
  return publicRegistrationAvailable === true;
}

export function publicRegistrationIsAvailable(): boolean {
  return isPublicRegistrationAllowed(status.publicRegistrationAvailable);
}

/**
 * Payment activity requires both a repository-level status decision and an
 * exact runtime enablement value. Variants such as "true", "01", or padded
 * values stay disabled.
 */
export function isPaymentActivityAllowed(
  commercialHoldActive: boolean,
  paymentsEnabled: string | undefined
): boolean {
  return !commercialHoldActive && paymentsEnabled === '1';
}

export function paymentsAreAvailable(): boolean {
  return isPaymentActivityAllowed(COMMERCIAL_HOLD_ACTIVE, process.env.PAYMENTS_ENABLED);
}

export class PaymentActivityDisabledError extends Error {
  readonly code = 'PAYMENTS_DISABLED';

  constructor() {
    super('Payment collection and billing-portal access are currently paused.');
    this.name = 'PaymentActivityDisabledError';
  }
}

export function assertPaymentActivityAllowed(): void {
  if (!paymentsAreAvailable()) {
    throw new PaymentActivityDisabledError();
  }
}

export function isPaymentActivityDisabledError(
  error: unknown
): error is PaymentActivityDisabledError {
  return (
    error instanceof PaymentActivityDisabledError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'PAYMENTS_DISABLED')
  );
}
