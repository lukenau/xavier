// Opening a file that is in the conversation: bytes over fetch with the Hub's
// cookie, written under their own name, handed to the iOS share sheet.
const mockWrite = jest.fn();
const mockCreate = jest.fn();
const mockDirCreate = jest.fn();
jest.mock('../lib/api', () => ({ HUB_ORIGIN: 'https://hub.test' }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'cache://' },
  Directory: jest.fn().mockImplementation(() => ({ create: (...a: unknown[]) => mockDirCreate(...a) })),
  File: jest.fn().mockImplementation(() => ({
    uri: 'file:///cache/hub-files/med_1/report.pdf',
    create: (...a: unknown[]) => mockCreate(...a),
    write: (...a: unknown[]) => mockWrite(...a),
  })),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { openFilePart, safeFileName } from './files';

const share = Sharing.shareAsync as jest.Mock;
const available = Sharing.isAvailableAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  available.mockResolvedValue(true);
  share.mockResolvedValue(undefined);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as unknown as typeof fetch;
});

it('fetches the bytes with the cookie, saves them, and opens the share sheet', async () => {
  const out = await openFilePart({ type: 'file', name: 'report.pdf', mime: 'application/pdf', media_id: 'med_1' });
  expect(global.fetch).toHaveBeenCalledWith('https://hub.test/api/chat/media/med_1', { credentials: 'include' });
  expect(mockWrite).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  expect(share).toHaveBeenCalledWith('file:///cache/hub-files/med_1/report.pdf', { mimeType: 'application/pdf', dialogTitle: 'report.pdf' });
  expect(out).toBe('opened');
});

it('has nothing to open when the Hub holds no bytes, and does not even ask', async () => {
  expect(await openFilePart({ type: 'file', name: 'big.zip' })).toBe('unavailable');
  expect(global.fetch).not.toHaveBeenCalled();
});

it('says unavailable, not failed, where there is no share sheet', async () => {
  available.mockResolvedValue(false);
  expect(await openFilePart({ type: 'file', name: 'a.pdf', media_id: 'med_1' })).toBe('unavailable');
  expect(global.fetch).not.toHaveBeenCalled();
});

it('fails cleanly when the server refuses or the write throws', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
  expect(await openFilePart({ type: 'file', name: 'a.pdf', media_id: 'med_1' })).toBe('failed');
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  mockWrite.mockImplementation(() => { throw new Error('disk full'); });
  expect(await openFilePart({ type: 'file', name: 'a.pdf', media_id: 'med_1' })).toBe('failed');
});

it('puts each file in its own folder so two reports cannot overwrite each other', async () => {
  await openFilePart({ type: 'file', name: 'report.pdf', media_id: 'med_1' });
  expect(mockDirCreate).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
  expect((File as unknown as jest.Mock).mock.calls[0][1]).toBe('report.pdf');
});

it('never writes a name that is a path or a dotfile', () => {
  expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
  expect(safeFileName('a/b\\c:d.pdf')).toBe('a_b_c_d.pdf');
  expect(safeFileName('.hidden')).toBe('hidden');
  expect(safeFileName(undefined)).toBe('file');
  expect(safeFileName('   ')).toBe('file');
  expect(safeFileName('x'.repeat(300)).length).toBe(120);
});
