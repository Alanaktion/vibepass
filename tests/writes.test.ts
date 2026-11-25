import { describe, expect, it } from 'vitest';
import { createSearchIndex } from '../src/search';
import type { CodedError } from '../src/shared/errors';
import { decryptString } from '../src/crypto';
import { newDraft } from '../src/vault/encrypt';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const LOGIN = {
  serverUrl: 'https://vault.example.com/',
  email: fixture.email,
  masterPassword: fixture.password,
};
const loginId = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!.id;

async function setup() {
  const server = fakeServer(fixture);
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service, deps } = createTestService(vault, search, server);
  await service.login(LOGIN);
  return { server, vault, search, service, deps };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as Partial<CodedError>).code ?? (error as Error).message;
  }
  return undefined;
}

describe('vault writes', () => {
  it('refuses every write while editing is turned off', async () => {
    const { service, deps, server } = await setup();
    deps.stored.writes = false;
    const draft = { ...newDraft(CipherType.Login), name: 'Nope' };
    expect(await codeOf(service.saveItem({ id: null, draft }))).toBe('writes-off');
    expect(await codeOf(service.trashItem(loginId))).toBe('writes-off');
    expect(await codeOf(service.createFolder('Nope'))).toBe('writes-off');
    expect(server.writes).toEqual([]);
  });

  it('creates a login and shows it right away, without a full sync', async () => {
    const { service, search, server, vault } = await setup();
    const syncs = server.calls.filter((c) => c === '/api/sync').length;
    const draft = newDraft(CipherType.Login);
    draft.name = 'New site';
    draft.login = {
      username: 'me@new.example',
      password: 'generated-password',
      totp: '',
      uris: [{ uri: 'https://new.example', match: null }],
    };
    const id = await service.saveItem({ id: null, draft });
    expect(server.writes[0]).toMatchObject({ method: 'POST', path: '/api/ciphers' });
    expect(JSON.stringify(server.writes[0]!.body)).not.toContain('generated-password');
    expect(search.search('new site').map((i) => i.id)).toEqual([id]);
    expect(vault.summary(id)?.subtitle).toBe('me@new.example');
    expect(await service.reveal(id, 'login.password')).toBe('generated-password');
    expect(server.calls.filter((c) => c === '/api/sync').length).toBe(syncs);
  });

  it('updates an item from the editor and keeps the cache in step', async () => {
    const { service, deps } = await setup();
    const editable = await service.editable(loginId);
    editable.draft.name = 'Renamed login';
    editable.draft.login!.password = 'changed';
    await service.saveItem({
      id: loginId,
      draft: editable.draft,
      revisionDate: editable.revisionDate,
    });
    const detail = await service.item(loginId);
    expect(detail.name).toBe('Renamed login');
    expect(await service.reveal(loginId, 'login.password')).toBe('changed');
    const cached = deps.stored.cache.get(fixture.sync.profile.id)!;
    expect(cached.ciphers.find((c) => c.id === loginId)!.passwordHistory).toHaveLength(1);
  });

  it('reports a conflict when another device changed the item, and can overwrite', async () => {
    const { service, server } = await setup();
    const editable = await service.editable(loginId);
    // Another client edits the item; the server now has a newer revision.
    server.sync = structuredClone(server.sync);
    server.sync.ciphers.find((c) => c.id === loginId)!.revisionDate = '2026-11-25T11:00:00.000Z';
    editable.draft.name = 'Mine';
    const save = (overwrite: boolean) =>
      service.saveItem({
        id: loginId,
        draft: editable.draft,
        revisionDate: editable.revisionDate,
        overwrite,
      });
    expect(await codeOf(save(false))).toBe('conflict');
    await save(true);
    expect((await service.item(loginId)).name).toBe('Mine');
  });

  it('a sync since the editor opened is a conflict too', async () => {
    const { service } = await setup();
    const editable = await service.editable(loginId);
    expect(
      await codeOf(service.saveItem({ id: loginId, draft: editable.draft, revisionDate: 'stale' })),
    ).toBe('conflict');
  });

  it('favorites and moves an item without re-encrypting it', async () => {
    const { service, server } = await setup();
    const folder = await service.createFolder('Banking');
    await service.organize(loginId, { favorite: true, folderId: folder.id });
    const partial = server.writes.at(-1)!;
    expect(partial).toMatchObject({
      method: 'PUT',
      path: `/api/ciphers/${loginId}/partial`,
      body: { favorite: true, folderId: folder.id },
    });
    const detail = await service.item(loginId);
    expect(detail.favorite).toBe(true);
    expect(detail.folder).toBe('Banking');
  });

  it('folders: create, rename, delete (items stay, without a folder)', async () => {
    const { service, server, vault } = await setup();
    const folder = await service.createFolder('  Travel  ');
    expect(folder.name).toBe('Travel');
    const sent = server.writes[0]!.body!.name as string;
    expect(sent).toMatch(/^2\./);
    expect(await decryptString(sent, vault.key!)).toBe('Travel');
    await service.organize(loginId, { folderId: folder.id });
    await service.renameFolder(folder.id, 'Trips');
    expect(vault.folders.find((f) => f.id === folder.id)?.name).toBe('Trips');
    await service.deleteFolder(folder.id);
    expect(vault.folders.some((f) => f.id === folder.id)).toBe(false);
    expect(vault.summary(loginId)?.folderId).toBeNull();
    expect(await codeOf(service.createFolder('   '))).toBe('Give the folder a name');
  });

  it('trash: move, restore, and delete for good only from the trash', async () => {
    const { service, search, vault } = await setup();
    expect(await codeOf(service.deleteItem(loginId))).toBe('Move the item to the trash first');
    await service.trashItem(loginId);
    expect(vault.summary(loginId)).toBeNull();
    expect(search.search('example').map((i) => i.id)).not.toContain(loginId);
    expect(service.trash().map((i) => i.id)).toEqual([loginId]);
    expect((await service.item(loginId)).deletedDate).not.toBeNull();

    await service.restoreItem(loginId);
    expect(vault.summary(loginId)).not.toBeNull();
    expect(service.trash()).toEqual([]);

    await service.trashItem(loginId);
    await service.deleteItem(loginId);
    expect(vault.raw(loginId)).toBeNull();
    expect(service.trash()).toEqual([]);
  });

  it('generates passwords into an encrypted history, and remembers the options', async () => {
    const { service, deps } = await setup();
    const first = await service.generatePassword();
    expect(first).toHaveLength(20);
    const phrase = await service.generatePassword({
      options: { ...deps.stored.generatorOptions, kind: 'passphrase' },
    });
    expect(phrase.split('-')).toHaveLength(4);
    expect((await service.generatorOptions()).kind).toBe('passphrase');
    // Site rules win over the user's options when the site declares them.
    const ruled = await service.generatePassword({ rules: 'minlength: 30; required: digit;' });
    expect(ruled.length).toBeGreaterThanOrEqual(30);

    const history = await service.generatorHistory();
    expect(history.map((h) => h.password)).toEqual([ruled, phrase, first]);
    expect(deps.stored.history.join()).not.toContain(first);
    await service.logout();
    expect(deps.stored.history).toEqual([]);
  });
});
