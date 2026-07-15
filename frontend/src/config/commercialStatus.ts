import status from '../../../commercial-status.json' with { type: 'json' };

/** Shared repository-level commercial status; see /commercial-status.json. */
export const COMMERCIAL_HOLD_ACTIVE = status.commercialHoldActive === true;
export const COMMERCIAL_HOLD_EFFECTIVE_DATE = status.effectiveDate;
export const COMMERCIAL_HOLD_MESSAGE = status.publicMessage;

/**
 * Public registration is fail-closed: only an explicit boolean false in the
 * shared status can make it eligible for a separately reviewed restoration.
 * Changing the status alone does not restore a registration form or Cognito
 * policy; see docs/COMMERCIAL-STATUS.md.
 */
export const PUBLIC_REGISTRATION_AVAILABLE = status.commercialHoldActive === false;
