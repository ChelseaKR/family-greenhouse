import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';

interface TotpChallengeFormProps {
  /** Handles its own failures: the page clears, then sets, `error`. */
  onSubmit: (code: string) => Promise<void>;
  onBack: () => void;
  /** Set by the page after a refused code, so the step says why. */
  error: string | null;
  isLoading: boolean;
}

/**
 * The second sign-in step (#671): one labeled field for the six-digit code
 * from the person's authenticator app. Focus moves to the field when the step
 * appears, so keyboard and screen-reader users land where the page changed.
 */
export function TotpChallengeForm({ onSubmit, onBack, error, isLoading }: TotpChallengeFormProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [formatError, setFormatError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A refused code clears the field and returns focus to it for the retry.
  useEffect(() => {
    if (error) {
      setCode('');
      inputRef.current?.focus();
    }
  }, [error]);

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const digits = code.replace(/\s+/g, '');
        if (!/^\d{6}$/.test(digits)) {
          setFormatError(t('security.totp.codeFormat'));
          inputRef.current?.focus();
          return;
        }
        setFormatError(null);
        void onSubmit(digits);
      }}
    >
      {error && <Alert variant="error">{error}</Alert>}
      <Input
        ref={inputRef}
        label={t('auth.mfa.codeLabel')}
        helperText={t('auth.mfa.codeHelper')}
        error={formatError ?? undefined}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        required
        value={code}
        onChange={(event) => {
          setCode(event.target.value);
          setFormatError(null);
        }}
      />
      <Button type="submit" className="w-full" isLoading={isLoading}>
        {t('auth.mfa.verify')}
      </Button>
      <p className="text-sm text-gray-700">{t('auth.mfa.lostDevice')}</p>
      <div className="text-center">
        <button
          type="button"
          className="text-sm font-medium text-primary-700 hover:text-primary-600"
          onClick={onBack}
        >
          {t('auth.mfa.back')}
        </button>
      </div>
    </form>
  );
}
