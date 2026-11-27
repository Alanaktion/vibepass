/**
 * Content script (top frame only). Detects login fields, reports them to the worker, shows the
 * inline menu on them, and fills them when the worker asks, which only happens after a user
 * gesture: the popup, the keyboard shortcut, or a trusted click or Enter in the inline menu.
 * It never holds secrets except for the moment of a fill.
 */
import browser from '../shared/browser';
import { isCodedError } from '../shared/errors';
import { log } from '../shared/log';
import {
  isContentRequest,
  type ContentRequest,
  type InlineMenuState,
  type PageInfo,
} from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import { SaveBanner } from './banner';
import {
  detectLoginFields,
  fieldAutocomplete,
  fillInput,
  isNewPasswordField,
  isPasswordInput,
  newPasswordFields,
  readSubmitted,
  restoreBrowserAutocomplete,
  suppressBrowserAutocomplete,
} from './detect';
import { InlineMenu, type MenuRow } from './menu';

export function countLoginForms(root: ParentNode = document): number {
  return root.querySelectorAll('input[type="password"]').length;
}

export function inspectPage(): PageInfo {
  const fields = detectLoginFields();
  return {
    url: location.href,
    fields: {
      username: fields.username !== null,
      password: fields.password !== null,
      totp: fields.totp !== null,
    },
  };
}

export function fillPage(request: Extract<ContentRequest, { type: 'content:fill' }>): {
  filled: string[];
} {
  // The page may have navigated since the worker matched the item: refuse a different origin.
  if (location.origin !== request.origin) throw new Error('The page changed before filling');
  const fields = detectLoginFields();
  const filled: string[] = [];
  // Filling moves focus between fields; that must not pop the inline menu back open.
  filling = true;
  try {
    if (fields.username && request.username) {
      fillInput(fields.username, request.username);
      filled.push('username');
    }
    if (fields.password && request.password) {
      fillInput(fields.password, request.password);
      filled.push('password');
    }
    if (fields.totp && request.totp && !fields.password) {
      fillInput(fields.totp, request.totp);
      filled.push('totp');
    }
  } finally {
    filling = false;
  }
  menu.close();
  if (filled.length === 0) throw new Error('No login fields found on this page');
  // Leave focus where the user would continue: the field after the last one we filled.
  return { filled };
}

// ---- Inline menu ----

let filling = false;
/** The last answer from the worker, so focus can show the menu (and hide the browser's own
 * dropdown) right away, before a fresh answer arrives. */
let cachedState: InlineMenuState | null = null;
/** Fields whose browser form history we turned off; restored when they lose focus. */
const suppressed = new Set<HTMLInputElement>();

let filterField: HTMLInputElement | null = null;

const menu = new InlineMenu({ onPick: (row) => void pick(row) });

type FieldKind = 'username' | 'password' | 'totp' | 'new-password';

function loginFieldKind(input: HTMLInputElement): FieldKind | null {
  if (isNewPasswordField(input)) return 'new-password';
  const fields = detectLoginFields();
  if (fields.password === input) return 'password';
  if (fields.username === input) return 'username';
  if (fields.totp === input) return 'totp';
  return null;
}

/** The rows to show for a field, or none. */
export function menuRows(state: InlineMenuState | null, input: HTMLInputElement): MenuRow[] {
  if (!state || state.state === 'off') return [];
  const kind = loginFieldKind(input);
  if (!kind) return [];
  if (kind === 'new-password') {
    // Sign up or change password: offer a new password, never an existing login.
    return state.state === 'unlocked' && state.canGenerate ? [{ kind: 'generate' }] : [];
  }
  if (state.state === 'locked') {
    // Only where it's clearly a login, so a newsletter email box doesn't nag while locked.
    const clear =
      kind === 'password' ||
      detectLoginFields().password !== null ||
      fieldAutocomplete(input).includes('username');
    return clear ? [{ kind: 'unlock' }] : [];
  }
  const query =
    input === filterField && kind === 'username' ? input.value.trim().toLowerCase() : '';
  const items = query
    ? state.items.filter(
        (item) =>
          item.name.toLowerCase().includes(query) || item.username?.toLowerCase().includes(query),
      )
    : state.items;
  if (query && state.items.length && !items.length)
    return [{ kind: 'message', text: 'No matching logins' }];
  return items.map((item) => ({ kind: 'item', item }));
}

async function refreshState(): Promise<InlineMenuState | null> {
  try {
    cachedState = await sendMessage('autofill:menu');
    offerToSave = cachedState.state === 'unlocked' && cachedState.offerToSave === true;
  } catch {
    log.debug('inline menu unavailable');
    cachedState = null;
  }
  return cachedState;
}

function show(input: HTMLInputElement, state: InlineMenuState | null): void {
  const rows = menuRows(state, input);
  if (rows.length === 0) {
    if (menu.anchor === input) menu.close();
    return;
  }
  suppressBrowserAutocomplete(input);
  suppressed.add(input);
  menu.open(input, rows);
}

function openFor(input: HTMLInputElement): void {
  show(input, cachedState);
  void refreshState().then((state) => {
    if (
      deepActiveElement() === input ||
      (menu.anchor === input && menu.containsFocusTarget(document.activeElement))
    )
      show(input, state);
  });
}

/** Fill a generated password into a new-password field and its confirm field. */
async function fillGenerated(anchor: HTMLInputElement): Promise<void> {
  const { password } = await sendMessage('autofill:generate', {
    rules: anchor.getAttribute('passwordrules'),
  });
  filling = true;
  try {
    for (const field of newPasswordFields(anchor)) fillInput(field, password);
  } finally {
    filling = false;
  }
  anchor.focus();
}

async function pick(row: MenuRow): Promise<void> {
  const anchor = menu.anchor;
  if (row.kind === 'message') return;
  if (row.kind === 'generate') {
    if (!anchor) return;
    try {
      await fillGenerated(anchor);
      menu.close();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not make a password';
      menu.open(anchor, [{ kind: 'message', text }]);
    }
    return;
  }
  if (row.kind === 'unlock' || row.item.reprompt) {
    menu.close();
    await sendMessage('autofill:open-popup').catch(() => {
      if (anchor) menu.open(anchor, [{ kind: 'message', text: 'Open Vibepass from the toolbar' }]);
    });
    return;
  }
  try {
    await sendMessage('autofill:menu-fill', { id: row.item.id });
    menu.close();
  } catch (error) {
    const text = isCodedError(error, 'reprompt-required')
      ? 'Open Vibepass to fill this login'
      : error instanceof Error
        ? error.message
        : 'Could not fill';
    if (anchor) menu.open(anchor, [{ kind: 'message', text }]);
  }
}

function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function inputFromEvent(event: Event): HTMLInputElement | null {
  const target = event.composedPath()[0];
  return target instanceof HTMLInputElement ? target : null;
}

function onFocusIn(event: FocusEvent): void {
  if (filling) return;
  const input = inputFromEvent(event);
  if (input && input !== menu.anchor) openFor(input);
}

function onFocusOut(event: FocusEvent): void {
  const input = inputFromEvent(event);
  if (!input) return;
  if (input === filterField) filterField = null;
  if (input === menu.anchor && !menu.containsFocusTarget(event.relatedTarget)) menu.close();
  if (suppressed.delete(input)) restoreBrowserAutocomplete(input);
}

/** Clicking a focused field reopens the menu after Escape closed it. */
function onClick(event: MouseEvent): void {
  if (!event.isTrusted || filling) return;
  const input = inputFromEvent(event);
  if (input && !menu.isOpen) openFor(input);
}

function onKeyDown(event: KeyboardEvent): void {
  // A page can dispatch fake key events; only real typing moves or picks.
  if (!event.isTrusted) return;
  const input = inputFromEvent(event);
  if (!input) return;
  if (!menu.isOpen || menu.anchor !== input) {
    if (event.key === 'ArrowDown' && !event.altKey) {
      show(input, cachedState);
      if (menu.isOpen) {
        event.preventDefault();
        menu.move(1);
      }
    }
    return;
  }
  const stop = () => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  switch (event.key) {
    case 'ArrowDown':
      stop();
      if (!event.altKey || !menu.focusSearch()) menu.move(1);
      break;
    case 'ArrowUp':
      stop();
      menu.move(-1);
      break;
    case 'Enter':
      // Nothing highlighted: Enter submits the form as usual.
      if (menu.pickActive()) stop();
      break;
    case 'Escape':
      stop();
      menu.close();
      break;
    case 'Tab':
      menu.close();
      break;
    default:
      break;
  }
}

export function startInlineMenu(): void {
  document.addEventListener(
    'input',
    (event) => {
      if (!event.isTrusted || filling) return;
      const input = inputFromEvent(event);
      if (!input || input !== menu.anchor || loginFieldKind(input) !== 'username') return;
      filterField = input;
      show(input, cachedState);
    },
    true,
  );
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  // Answer the first focus without waiting on the worker (and it may already be focused).
  const fields = detectLoginFields();
  if (fields.username || fields.password || fields.totp) {
    void refreshState().then(() => {
      const active = deepActiveElement();
      if (active instanceof HTMLInputElement && !menu.isOpen) show(active, cachedState);
    });
  }
}

/** For tests. */
export function inlineMenu(): InlineMenu {
  return menu;
}

// ---- Save and update banner ----

const banner = new SaveBanner({
  onAnswer: async (answer) => (await sendMessage('autofill:save-answer', answer)).message,
});

/** For tests. */
export function saveBanner(): SaveBanner {
  return banner;
}

let lastCapture = { key: '', at: 0 };
/**
 * Whether the worker would offer to save (unlocked, editing and saving on). Until it says so,
 * submitted passwords are not sent to it at all.
 */
let offerToSave = false;

/**
 * A login, sign-up, or password-change form is being submitted: send what it holds to the
 * worker, which decides whether to offer saving it. Real user actions only.
 */
export async function captureSubmit(scope: HTMLFormElement | Document): Promise<void> {
  if (!offerToSave) return;
  const login = readSubmitted(scope);
  if (!login) return;
  // A click on the submit button and the submit event that follows are one submit.
  const key = JSON.stringify(login);
  if (key === lastCapture.key && Date.now() - lastCapture.at < 2000) return;
  lastCapture = { key, at: Date.now() };
  try {
    const prompt = await sendMessage('autofill:submitted', login);
    if (prompt) banner.show(prompt);
  } catch {
    log.debug('save check failed');
  }
}

function scopeOf(el: Element | null): HTMLFormElement | Document {
  const form = el?.closest('form');
  return form ?? document;
}

const SUBMIT_TEXT =
  /^(log ?in|sign ?in|sign ?up|register|create|continue|next|submit|save|update|change|join|done|ok|go)\b/i;

function looksLikeSubmit(el: Element): boolean {
  const button = el.closest('button, input[type="submit"], input[type="image"], [role="button"]');
  if (!button) return false;
  if (button instanceof HTMLButtonElement && button.form) return button.type === 'submit';
  if (button instanceof HTMLInputElement) return true;
  const text = (button.textContent || button.getAttribute('aria-label') || '').trim();
  return SUBMIT_TEXT.test(text);
}

function onSubmit(event: SubmitEvent): void {
  if (!event.isTrusted) return;
  if (event.target instanceof HTMLFormElement) void captureSubmit(event.target);
}

/** Many sites submit with script on a button click and never fire a submit event. */
function onSubmitClick(event: MouseEvent): void {
  if (!event.isTrusted) return;
  const target = event.composedPath()[0];
  if (!(target instanceof Element) || !looksLikeSubmit(target)) return;
  void captureSubmit(scopeOf(target));
}

/** Enter in a password field submits most forms, with or without a submit event. */
function onSubmitKey(event: KeyboardEvent): void {
  if (!event.isTrusted || event.key !== 'Enter' || menu.isOpen) return;
  const input = inputFromEvent(event);
  if (!input || !isPasswordInput(input)) return;
  void captureSubmit(scopeOf(input));
}

export function startSaveBanner(): void {
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('click', onSubmitClick, true);
  document.addEventListener('keydown', onSubmitKey, true);
  // A submit that navigated here: the worker still has the banner for this site.
  sendMessage('autofill:pending-prompt')
    .then(({ prompt, offer }) => {
      offerToSave = offer;
      if (prompt) banner.show(prompt);
    })
    .catch(() => undefined);
}

function handle(message: unknown): Promise<unknown> | undefined {
  if (!isContentRequest(message)) return undefined;
  return Promise.resolve().then(() =>
    message.type === 'content:inspect' ? inspectPage() : fillPage(message),
  );
}

declare global {
  interface Window {
    __vibepassContent?: boolean;
  }
}

function main(): void {
  // Only the top frame; cross-origin iframes are refused by design. The flag stops a second
  // copy when the worker injects the script into a tab that already has it.
  if (window.top !== window || window.__vibepassContent) return;
  window.__vibepassContent = true;
  browser.runtime.onMessage.addListener(handle);
  startInlineMenu();
  startSaveBanner();
  sendMessage('autofill:page-ready', {
    url: location.href,
    loginForms: countLoginForms(),
  }).catch(() => {
    log.error('page-ready failed');
  });
}

main();
