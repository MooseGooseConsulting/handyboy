import { describe, expect, it } from 'vitest';
import { probeAnomalies, runStealthProbe } from './probe';

const clean = {
  navigator: { webdriver: false },
  pointerEventHasCoalesced: true,
  isSecureContext: true,
  globalNames: [],
};

describe('stealth probe', () => {
  it('webdriver true, a page-world chrome.runtime, and a puppeteer global are anomalies', () => {
    const findings = runStealthProbe({
      ...clean,
      navigator: { webdriver: true },
      pageChromeRuntime: {},
      globalNames: ['__puppeteer'],
    });
    expect(probeAnomalies(findings)).toEqual(
      expect.arrayContaining(['webdriver', 'main-world-execution', 'playwright-init-globals']),
    );
  });

  it('webdriver false on a secure page with coalesced events is not flagged as driven', () => {
    const findings = runStealthProbe(clean);
    expect(probeAnomalies(findings)).not.toContain('webdriver');
    expect(probeAnomalies(findings)).not.toContain('main-world-execution');
    expect(probeAnomalies(findings)).not.toContain('coalesced-events');
  });
});
