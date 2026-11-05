import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { onlineManager } from '@tanstack/react-query';
import i18n from '@/i18n';
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import {
  OfflineSaveError,
  assertOnlineForSave,
  failFastSave,
  saveErrorMessage,
} from '@/services/failFastSave';

afterEach(async () => {
  onlineManager.setOnline(true);
  await i18n.changeLanguage('en');
});

describe('failFastSave', () => {
  it('never pauses, and runs the save when online', async () => {
    const save = vi.fn(async (n: number) => n * 2);
    const options = failFastSave(save);
    expect(options.networkMode).toBe('always');
    await expect(options.mutationFn(21)).resolves.toBe(42);
    expect(save).toHaveBeenCalledWith(21);
  });

  it('refuses offline before calling the save at all', async () => {
    const save = vi.fn(async () => 'sent');
    onlineManager.setOnline(false);
    await expect(failFastSave(save).mutationFn(undefined)).rejects.toBeInstanceOf(OfflineSaveError);
    expect(save).not.toHaveBeenCalled();
    expect(() => assertOnlineForSave()).toThrow(OfflineSaveError);
  });
});

describe('saveErrorMessage', () => {
  it('says an offline save sent nothing', () => {
    expect(saveErrorMessage(new OfflineSaveError())).toBe(
      "You're offline. Nothing was saved. Try again once you're connected."
    );
  });

  it('keeps the usual "Can\'t reach" message for a request that got no answer', () => {
    const noAnswer = new AxiosError('Network Error', AxiosError.ERR_NETWORK);
    expect(saveErrorMessage(noAnswer)).toBe(
      "Can't reach Family Greenhouse. Check your connection and try again."
    );
  });

  it('is Spanish in Spanish', async () => {
    await ensureLocaleCatalog(i18n, 'es');
    await i18n.changeLanguage('es');
    expect(saveErrorMessage(new OfflineSaveError())).toBe(
      'Estás sin conexión. No se guardó nada. Inténtalo de nuevo cuando tengas conexión.'
    );
  });
});
