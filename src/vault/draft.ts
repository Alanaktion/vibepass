/** Draft helpers with no crypto, so the popup can use them without loading the SDK. */
import { CipherType, type ItemDraft } from './types';

/** An empty draft for a new item. */
export function newDraft(type: CipherType.Login | CipherType.SecureNote): ItemDraft {
  return {
    type,
    name: '',
    notes: '',
    favorite: false,
    folderId: null,
    reprompt: false,
    login: type === CipherType.Login ? { username: '', password: '', totp: '', uris: [] } : null,
    fields: [],
  };
}
