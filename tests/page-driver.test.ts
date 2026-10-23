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
      get: vi.fn(async () => ({ windowId: 1, active: true, status: 'complete' })),
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

  it('screenshot returns the capture when the run tab stays the active tab of its window', async () => {
    const chrome = api();
    const result = await new PageDriver(chrome).screenshot(3);
    expect(result.ok).toBe(true);
    expect(result.dataUrl).toBe('data:image/png;base64,x');
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
  });

  it('screenshot refuses without capturing when the run tab is in the background, since the capture would show another tab', async () => {
    const chrome = api();
    chrome.tabs.get = vi.fn(async () => ({ windowId: 1, active: false, status: 'complete' }));
    const result = await new PageDriver(chrome).screenshot(3);
    expect(result.ok).toBe(false);
    expect(result.dataUrl).toBeUndefined();
    expect(result.error).toContain('tab 3 is not the active tab');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('screenshot discards the capture when another tab became active while it was taken', async () => {
    const chrome = api();
    chrome.tabs.get = vi
      .fn()
      .mockResolvedValueOnce({ windowId: 1, active: true })
      .mockResolvedValueOnce({ windowId: 1, active: false });
    const result = await new PageDriver(chrome).screenshot(3);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.dataUrl).toBeUndefined();
    expect(result.error).toContain('screenshot discarded');
  });

  it('screenshot discards the capture when the run tab moved to another window while it was taken', async () => {
    const chrome = api();
    chrome.tabs.get = vi
      .fn()
      .mockResolvedValueOnce({ windowId: 1, active: true })
      .mockResolvedValueOnce({ windowId: 2, active: true });
    const result = await new PageDriver(chrome).screenshot(3);
    expect(result.ok).toBe(false);
    expect(result.dataUrl).toBeUndefined();
    expect(result.error).toContain('another window');
  });
});
