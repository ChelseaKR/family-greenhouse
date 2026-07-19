import status from '../../../commercial-status.json' with { type: 'json' };

/** Shared repository-level commercial status; see /commercial-status.json. */
export const COMMERCIAL_HOLD_ACTIVE = status.commercialHoldActive === true;
export const COMMERCIAL_HOLD_EFFECTIVE_DATE = status.effectiveDate;
export const COMMERCIAL_HOLD_MESSAGE = status.publicMessage;

/** Public registration is independent from the paid-plan commercial hold. */
export const PUBLIC_REGISTRATION_AVAILABLE = status.publicRegistrationAvailable === true;
