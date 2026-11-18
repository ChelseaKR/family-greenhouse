/**
 * Guideline 5.1.2(i): inside the iOS and Android apps, nothing is sent to a
 * third-party AI service (Amazon Bedrock) or to Plant.id until the person has
 * said yes on that device, in a dialog that names the service and what goes
 * to it. "Not now" sends nothing. The website keeps its privacy-policy
 * disclosure and asks nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  hasThirdPartyConsent,
  useThirdPartyConsent,
  type ThirdPartyUse,
} from '@/hooks/useThirdPartyConsent';

function Harness({ use, action }: { use: ThirdPartyUse; action: () => void }) {
  const consent = useThirdPartyConsent(use);
  return (
    <>
      <button type="button" onClick={() => consent.run(action)}>
        Go
      </button>
      {consent.dialog}
    </>
  );
}

function enterShell(platform: 'ios' | 'android') {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  localStorage.clear();
});

describe('useThirdPartyConsent', () => {
  it('on the website, runs the action without asking', async () => {
    const action = vi.fn();
    render(<Harness use="identify" action={action} />);

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(action).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('in the app, names Plant.id and what it may do with the photo before anything is sent', async () => {
    enterShell('ios');
    const action = vi.fn();
    render(<Harness use="identify" action={action} />);

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Send this photo to Plant.id?');
    expect(dialog).toHaveTextContent(/keep and reuse the photos it receives/);
    expect(action).not.toHaveBeenCalled();
  });

  it('"Not now" sends nothing and remembers nothing', async () => {
    enterShell('ios');
    const action = vi.fn();
    render(<Harness use="chat" action={action} />);

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Send your question to Amazon Bedrock?'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(action).not.toHaveBeenCalled();
    expect(hasThirdPartyConsent('chat')).toBe(false);
  });

  it('"Allow" runs the action, and the next one on this device goes without asking', async () => {
    enterShell('android');
    const action = vi.fn();
    render(<Harness use="leafHealth" action={action} />);

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Send this leaf photo to Amazon Bedrock?'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(action).toHaveBeenCalledOnce();
    expect(hasThirdPartyConsent('leafHealth')).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('asks separately for each use: a yes to chat is not a yes to Plant.id', async () => {
    enterShell('ios');
    const chat = vi.fn();
    const { unmount } = render(<Harness use="chat" action={chat} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(chat).toHaveBeenCalledOnce();
    unmount();

    const identify = vi.fn();
    render(<Harness use="identify" action={identify} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Send this photo to Plant.id?');
    expect(identify).not.toHaveBeenCalled();
  });

  it('still asks, and still works for this session, when storage is blocked', async () => {
    enterShell('ios');
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const action = vi.fn();
      render(<Harness use="identify" action={action} />);
      await userEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
      expect(action).toHaveBeenCalledOnce();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
