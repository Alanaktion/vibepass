import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { VaultStatus } from '../shared/messages';
import type { Settings } from '../storage/settings';
import type { ActiveTab, AskPassword } from './lib';

export interface PopupContext {
  status: VaultStatus;
  onStatus: (status: VaultStatus) => void;
  settings: Settings | null;
  tab: ActiveTab | null;
  askPassword: AskPassword;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  toast: (message: string) => void;
}

export const Ctx = createContext<PopupContext | null>(null);

export function usePopup(): PopupContext {
  const value = useContext(Ctx);
  if (!value) throw new Error('usePopup outside the popup');
  return value;
}
