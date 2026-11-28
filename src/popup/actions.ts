import { isCodedError } from '../shared/errors';
import type { RepromptFields } from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import type { CipherSummary } from '../vault/types';
import type { PopupContext } from './context';
import { copyText, errorMessage, withReprompt, type RepromptAnswer } from './lib';
import { popupSession } from './session';

export type CopyWhat = 'username' | 'password' | 'totp';

const COPIED: Record<CopyWhat, string> = {
  username: 'Username copied',
  password: 'Password copied',
  totp: 'One-time password copied',
};

function clearNote(ctx: PopupContext): string {
  const seconds = ctx.settings?.clipboardClearSeconds ?? 0;
  return seconds > 0 ? ` · clears in ${String(seconds)}s` : '';
}

/** Copy one field of an item, asking for the master password if the item wants it. */
export async function copyField(
  ctx: PopupContext,
  item: Pick<CipherSummary, 'id' | 'subtitle' | 'hasTotp'>,
  what: CopyWhat,
): Promise<void> {
  try {
    let value: string | null;
    if (what === 'username') {
      value = item.subtitle;
    } else if (what === 'password') {
      value = await withReprompt(ctx.askPassword, (masterPassword) =>
        sendMessage('vault:reveal', {
          id: item.id,
          fieldId: 'login.password',
          ...pw(masterPassword),
        }),
      );
    } else {
      if (!item.hasTotp) {
        ctx.toast('This item has no one-time password');
        return;
      }
      const code = await withReprompt(ctx.askPassword, (masterPassword) =>
        sendMessage('vault:totp', { id: item.id, ...pw(masterPassword) }),
      );
      value = code?.code ?? null;
    }
    if (!value) {
      if (what === 'username') ctx.toast('This item has no username');
      return;
    }
    await copyText(value);
    ctx.toast(COPIED[what] + (what === 'username' ? '' : clearNote(ctx)));
  } catch (error) {
    ctx.toast(errorMessage(error, 'Could not copy'));
  }
}

/**
 * Re-prompt fields for a request: the popup's session (so a password entered once covers the
 * rest of this popup's life) and the master password or PIN when the user just typed it.
 */
export function pw(answer: RepromptAnswer | undefined): RepromptFields {
  const session = popupSession();
  return {
    ...(session === undefined ? {} : { session }),
    ...answer,
  };
}

/**
 * Fill an item into the tab the popup opened over, then close the popup. Asks before filling
 * an item that isn't saved for the page, and for the master password on re-prompt items.
 */
export async function fillItem(ctx: PopupContext, id: string): Promise<boolean> {
  const tab = ctx.tab;
  if (!tab) {
    ctx.toast('Open a web page to fill');
    return false;
  }
  let confirmedOrigin: string | undefined;
  let confirmedFrames: string[] | undefined;
  const run = () =>
    withReprompt(ctx.askPassword, (masterPassword) =>
      sendMessage('autofill:fill', {
        tabId: tab.id,
        id,
        ...(confirmedOrigin === undefined ? {} : { confirmedOrigin }),
        ...(confirmedFrames === undefined ? {} : { confirmedFrames }),
        ...pw(masterPassword),
      }),
    );
  try {
    let result;
    // Up to two questions: an insecure page, then a form hosted by another site.
    for (let attempt = 0; ; attempt++) {
      try {
        result = await run();
        break;
      } catch (error) {
        if (!isCodedError(error, 'fill-mismatch') || attempt >= 2) throw error;
        const details = error.details as { origin?: unknown; frames?: unknown } | undefined;
        const frames = Array.isArray(details?.frames)
          ? details.frames.filter((f): f is string => typeof f === 'string')
          : [];
        if (typeof details?.origin !== 'string' && frames.length === 0) throw error;
        if (!(await ctx.confirm(`${error.message}. Fill anyway?`, 'Fill anyway'))) return false;
        if (typeof details?.origin === 'string') confirmedOrigin = details.origin;
        else confirmedFrames = [...(confirmedFrames ?? []), ...frames];
      }
    }
    if (!result) return false;
    if (result.copiedTotp) {
      ctx.toast(`Filled · one-time password copied${clearNote(ctx)}`);
      setTimeout(() => {
        window.close();
      }, 900);
    } else {
      window.close();
    }
    return true;
  } catch (error) {
    ctx.toast(errorMessage(error, 'Could not fill'));
    return false;
  }
}
