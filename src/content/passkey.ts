/**
 * Passkey content script (top frame, document start). Answers the page script's stand-in for
 * navigator.credentials: asks the worker what the vault has for this site, asks the user with
 * Vibepass's own prompt, and passes the signed answer back. With nothing to offer it says
 * "fallback" at once, and the browser handles the request as if Vibepass weren't there.
 */
import { isCodedError } from '../shared/errors';
import { log } from '../shared/log';
import { sendMessage } from '../shared/messaging';
import {
  PAGE_CHANNEL,
  type PageRequestMessage,
  type PageResponseMessage,
  type PageResult,
  type PasskeyCreateRequest,
  type PasskeyGetRequest,
} from '../shared/webauthn';
import { PasskeyPrompt } from './passkey-prompt';

const prompt = new PasskeyPrompt();
/** How often to look again while the user unlocks Vibepass in the popup. */
const UNLOCK_POLL_MS = 1000;
/** Give up waiting for an unlock after this long (sites time out around here too). */
const UNLOCK_WAIT_MS = 5 * 60_000;

const cancelled = (): PageResult => ({
  kind: 'error',
  name: 'NotAllowedError',
  message: 'The operation either timed out or was not allowed.',
});

/** The request on screen. A new one, or the page aborting, ends it. */
let current: { id: string; end: (result: PageResult) => void } | null = null;

function errorText(error: unknown): string {
  if (isCodedError(error, 'locked')) return 'Vibepass locked. Unlock it and try again.';
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Show the locked prompt and wait for the vault to unlock. Resolves true once unlocked, or with
 * the user's way out.
 */
async function unlockFirst(
  check: () => Promise<boolean>,
  end: (result: PageResult) => void,
): Promise<boolean> {
  const answer = await prompt.locked();
  if (answer.action === 'cancel') {
    end(cancelled());
    return false;
  }
  if (answer.action === 'browser') {
    end({ kind: 'fallback' });
    return false;
  }
  await sendMessage('autofill:open-popup').catch(() => undefined);
  return new Promise((resolve) => {
    const state = { stop: false };
    const stopped = () => state.stop;
    const quit = (result: PageResult) => {
      state.stop = true;
      end(result);
      resolve(false);
    };
    prompt.waiting(
      () => {
        quit(cancelled());
      },
      () => {
        quit({ kind: 'fallback' });
      },
    );
    const started = Date.now();
    const poll = async () => {
      while (!stopped() && Date.now() - started < UNLOCK_WAIT_MS) {
        await new Promise((r) => setTimeout(r, UNLOCK_POLL_MS));
        if (stopped()) return;
        if (await check().catch(() => false)) {
          resolve(true);
          return;
        }
      }
      if (!stopped()) quit(cancelled());
    };
    void poll();
  });
}

async function handleGet(
  request: PasskeyGetRequest,
  end: (result: PageResult) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const query = { rpId: request.rpId, allowCredentials: request.allowCredentials };
  let options = await sendMessage('passkey:get-options', query);
  if (options.state === 'locked') {
    const unlocked = await unlockFirst(async () => {
      options = await sendMessage('passkey:get-options', query);
      return options.state !== 'locked';
    }, end);
    if (!unlocked || !isCurrent()) return;
  }
  if (options.state !== 'ready' || options.passkeys.length === 0) {
    end({ kind: 'fallback' });
    return;
  }
  for (;;) {
    const answer = await prompt.choose(options.rpId, options.passkeys);
    if (!isCurrent()) return;
    if (answer.action === 'cancel') {
      end(cancelled());
      return;
    }
    if (answer.action === 'browser') {
      end({ kind: 'fallback' });
      return;
    }
    prompt.busy('Signing in…');
    try {
      const credential = await sendMessage('passkey:get', {
        request,
        cipherId: answer.choice.cipherId,
        credentialId: answer.choice.credentialId,
      });
      end({ kind: 'get', credential });
      return;
    } catch (error) {
      if (!isCurrent()) return;
      // Show the list again with the reason, so the user can pick again or use the browser.
      const reason = errorText(error);
      queueMicrotask(() => {
        prompt.error(reason);
      });
    }
  }
}

async function handleCreate(
  request: PasskeyCreateRequest,
  end: (result: PageResult) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const query = {
    rpId: request.rp.id,
    algorithms: request.algorithms,
    excludeCredentials: request.excludeCredentials,
    userName: request.user.name,
  };
  let options = await sendMessage('passkey:create-options', query);
  if (options.state === 'locked') {
    const unlocked = await unlockFirst(async () => {
      options = await sendMessage('passkey:create-options', query);
      return options.state !== 'locked';
    }, end);
    if (!unlocked || !isCurrent()) return;
  }
  if (options.state === 'excluded') {
    await prompt.already(options.rpId, options.name);
    if (!isCurrent()) return;
    end({
      kind: 'error',
      name: 'InvalidStateError',
      message:
        'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.',
    });
    return;
  }
  if (options.state !== 'ready') {
    end({ kind: 'fallback' });
    return;
  }
  for (;;) {
    const answer = await prompt.save(options.rpId, request.user.name, options.logins);
    if (!isCurrent()) return;
    if (answer.action === 'cancel') {
      end(cancelled());
      return;
    }
    if (answer.action === 'browser') {
      end({ kind: 'fallback' });
      return;
    }
    prompt.busy('Saving…');
    try {
      const credential = await sendMessage('passkey:create', {
        request,
        cipherId: answer.cipherId,
      });
      end({ kind: 'create', credential });
      return;
    } catch (error) {
      if (!isCurrent()) return;
      const reason = errorText(error);
      queueMicrotask(() => {
        prompt.error(reason);
      });
    }
  }
}

function reply(message: PageResponseMessage): void {
  window.postMessage(message, location.origin === 'null' ? '*' : location.origin);
}

function onRequest(data: PageRequestMessage): void {
  if (data.kind === 'abort') {
    if (current?.id === data.id) {
      current = null;
      prompt.close();
    }
    return;
  }
  reply({ channel: PAGE_CHANNEL, dir: 'ack', id: data.id });
  if (data.kind === 'available') {
    // A capability check, not a request: it must not end the prompt on screen.
    const id = data.id;
    void sendMessage('passkey:available')
      .then(({ available }) => available)
      .catch(() => false)
      .then((available) => {
        reply({
          channel: PAGE_CHANNEL,
          dir: 'response',
          id,
          result: { kind: 'available', available },
        });
      });
    return;
  }
  // One prompt at a time: a new request ends the one on screen.
  current?.end(cancelled());

  const id = data.id;
  let ended = false;
  const end = (result: PageResult) => {
    if (ended) return;
    ended = true;
    if (current?.id === id) {
      current = null;
      prompt.close();
    }
    reply({ channel: PAGE_CHANNEL, dir: 'response', id, result });
  };
  current = { id, end };
  const isCurrent = () => !ended && current?.id === id;

  const run =
    data.kind === 'get'
      ? handleGet(data.request, end, isCurrent)
      : handleCreate(data.request, end, isCurrent);
  run.catch(() => {
    // The worker couldn't be reached or refused: let the browser handle it.
    log.debug('passkey request handed to the browser');
    end({ kind: 'fallback' });
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Partial<PageRequestMessage> | null;
  if (data?.channel !== PAGE_CHANNEL || data.dir !== 'request' || typeof data.id !== 'string') {
    return;
  }
  onRequest(data as PageRequestMessage);
});
