import { describe, expect, it, vi } from 'vitest';
import { PageDriver, type ChromeApi } from '@/src/page/driver';

function api(over: Partial<ChromeApi> = {}): ChromeApi & { listeners: Array<(tabId: number, info: { status?: string }) => void> } {
  const listeners: Array<(tabId: number, info: { status?: string }) => void> = [];
  return {
    listeners,
    scripting: { executeScript: vi.fn(async () => []) },
    tabs: {
      sendMessage: vi.fn(async () => ({ ok: true as const })),
      update: vi.fn(async () => ({})),
      get: vi.fn(async () => ({ windowId: 1, status: 'complete' })),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,x'),
      onUpdated: {
        addListener(fn) {
          listeners.push(fn);
        },
        removeListener(fn) {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
    ...over,
  };
}

describe('page driver', () => {
  it('download fails closed when the downloads permission is absent', async () => {
    const chrome = api();
    const result = await new PageDriver(chrome).download('https://shop.example/file.csv', 'file.csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('downloads');
  });

  it('save_file writes under handyboy/ and does not prompt or overwrite', async () => {
    const seen: Array<{ filename?: string; saveAs?: boolean; conflictAction?: string }> = [];
    const chrome = api({
      downloads: {
        download: async (options) => {
          seen.push(options);
          return 7;
        },
      },
    });
    const result = await new PageDriver(chrome).saveFile('data:text/plain,hi', 'report.txt');
    expect(result).toEqual({ ok: true, downloadId: 7 });
    expect(seen).toEqual([
      {
        url: 'data:text/plain,hi',
        filename: 'handyboy/report.txt',
        saveAs: false,
        conflictAction: 'uniquify',
      },
    ]);
  });

  it('navigate drops its tab listener once the tab reports complete', async () => {
    const chrome = api();
    const pending = new PageDriver(chrome).navigate(3, 'https://shop.example/');
    expect(chrome.listeners).toHaveLength(1);
    chrome.listeners[0]?.(3, { status: 'complete' });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(chrome.listeners).toHaveLength(0);
  });
});
