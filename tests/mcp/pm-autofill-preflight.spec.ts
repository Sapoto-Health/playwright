/**
 * Unit tests for the PM autofill preflight ladder. Uses Playwright's own
 * test runner with a real Chromium page loaded from data: URLs that
 * simulate various PM behaviors (fills on load, fills after reload, fills
 * after focus, never fills, preview-retracts).
 */
import { test, expect } from '@playwright/test';
import { runPmAutofillPreflight } from '../../packages/playwright/src/mcp/browser/pmAutofillPreflight';

function htmlForm(body: string) {
  return `data:text/html,<!doctype html><html><body>
    <form>
      <input name="username" type="text" />
      <input name="password" type="password" />
      <button type="submit">Submit</button>
    </form>
    <script>${body}</script>
  </body></html>`;
}

test('rung 1 succeeds — baseline fill', async ({ page }) => {
  await page.goto(htmlForm(`
    setTimeout(() => {
      document.querySelector('[name=username]').value = 'u';
      document.querySelector('[name=password]').value = 'p';
    }, 300);
  `));
  const result = await runPmAutofillPreflight({ page });
  expect(result.status).toBe('filled');
  if (result.status === 'filled') expect(result.technique).toBe('baseline');
});

test('rung 2 succeeds — fills only after reload', async ({ page }) => {
  // First load: never fills. After a reload, the script checks sessionStorage
  // and fills. page.reload() inside the ladder triggers rung 2.
  const body = `
    if (sessionStorage.getItem('reloaded')) {
      document.querySelector('[name=username]').value = 'u';
      document.querySelector('[name=password]').value = 'p';
    } else {
      sessionStorage.setItem('reloaded', '1');
    }
  `;
  await page.goto(htmlForm(body));
  const result = await runPmAutofillPreflight({
    page,
    budgetMs: { baseline: 800, refresh: 1500, focusClick: 800, noFormWait: 1000 },
  });
  expect(result.status).toBe('filled');
  if (result.status === 'filled') expect(result.technique).toBe('refresh');
});

test('rung 3 succeeds — fills after username focus-click', async ({ page }) => {
  await page.goto(htmlForm(`
    document.querySelector('[name=username]').addEventListener('focus', () => {
      document.querySelector('[name=username]').value = 'u';
      document.querySelector('[name=password]').value = 'p';
    });
  `));
  const result = await runPmAutofillPreflight({
    page,
    budgetMs: { baseline: 800, refresh: 800, focusClick: 1500, noFormWait: 1000 },
  });
  expect(result.status).toBe('filled');
  if (result.status === 'filled') expect(result.technique).toBe('focus-click');
});

test('all rungs fail — returns empty with all three tried', async ({ page }) => {
  await page.goto(htmlForm(''));
  const result = await runPmAutofillPreflight({
    page,
    budgetMs: { baseline: 500, refresh: 500, focusClick: 500, noFormWait: 500 },
  });
  expect(result.status).toBe('empty');
  if (result.status === 'empty') {
    expect(result.triedTechniques).toEqual(['baseline', 'refresh', 'focus-click']);
  }
});

test('no password field — returns no-form', async ({ page }) => {
  await page.goto('data:text/html,<!doctype html><html><body><h1>No form here</h1></body></html>');
  const result = await runPmAutofillPreflight({
    page,
    budgetMs: { baseline: 500, refresh: 500, focusClick: 500, noFormWait: 500 },
  });
  expect(result.status).toBe('no-form');
});

test('preview-retract — not reported as filled (two-consecutive-hits)', async ({ page }) => {
  await page.goto(htmlForm(`
    setTimeout(() => {
      const pw = document.querySelector('[name=password]');
      pw.value = 'preview';
      setTimeout(() => { pw.value = ''; }, 100);
    }, 200);
  `));
  const result = await runPmAutofillPreflight({
    page,
    budgetMs: { baseline: 600, refresh: 500, focusClick: 500, noFormWait: 500 },
    pollIntervalMs: 150,
  });
  // Preview appears and vanishes inside the baseline window without two
  // consecutive hits, so the ladder continues to later rungs.
  expect(result.status).toBe('empty');
});

test('bypasses React-style value-descriptor override', async ({ page }) => {
  await page.goto(htmlForm(`
    const pw = document.querySelector('[name=password]');
    Object.defineProperty(pw, 'value', {
      get() { return ''; },
      set() {},
      configurable: true,
    });
    setTimeout(() => {
      const native = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value',
      ).set;
      native.call(pw, 'real');
      const un = document.querySelector('[name=username]');
      native.call(un, 'real');
    }, 200);
  `));
  const result = await runPmAutofillPreflight({
    page,
    budgetMs: { baseline: 1500, refresh: 500, focusClick: 500, noFormWait: 500 },
  });
  expect(result.status).toBe('filled');
  if (result.status === 'filled') {
    expect(result.hasPassword).toBe(true);
    expect(result.hasUsername).toBe(true);
  }
});

test('idempotent on already-filled form — returns baseline quickly', async ({ page }) => {
  await page.goto(htmlForm(`
    document.querySelector('[name=username]').value = 'u';
    document.querySelector('[name=password]').value = 'p';
  `));
  const t0 = Date.now();
  const result = await runPmAutofillPreflight({ page });
  const tookMs = Date.now() - t0;
  expect(result.status).toBe('filled');
  if (result.status === 'filled') expect(result.technique).toBe('baseline');
  // With 250ms poll and two-consecutive-hits rule, first hit is immediate
  // and second is ~250ms later. 2s is a generous upper bound.
  expect(tookMs).toBeLessThan(2000);
});
