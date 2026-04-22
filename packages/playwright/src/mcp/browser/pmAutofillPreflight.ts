/**
 * Password Manager Autofill Preflight — deterministic recovery ladder.
 *
 * Exposed by the browser_wait_for_pm_autofill MCP tool. Invoked by the
 * Sapoto LoginAgent when it reaches a login form in PM-autofill credential
 * mode. Three rungs: baseline wait → refresh → focus-click. See
 * docs/superpowers/specs/2026-04-21-pm-autofill-preflight-design.md in the
 * Sapoto repo for the full design.
 */

import type { Page, Locator } from 'playwright-core';

export type Technique = 'baseline' | 'refresh' | 'focus-click';

export interface PreflightOptions {
  page: Page;
  passwordSelector?: string;
  usernameSelector?: string;
  budgetMs?: {
    baseline?: number;
    refresh?: number;
    focusClick?: number;
    noFormWait?: number;
  };
  pollIntervalMs?: number;
  logger?: (line: string) => void;
}

export type PreflightResult =
  | {
      status: 'filled';
      technique: Technique;
      elapsedMs: number;
      hasUsername: boolean;
      hasPassword: boolean;
    }
  | { status: 'no-form'; elapsedMs: number }
  | {
      status: 'empty';
      triedTechniques: Technique[];
      elapsedMs: number;
    };

const DEFAULT_BUDGET = {
  baseline: 5000,
  refresh: 5000,
  focusClick: 3000,
  noFormWait: 2000,
};

const DEFAULT_POLL_MS = 250;

const DEFAULT_PASSWORD_SELECTOR =
  'input[type="password"]:not([aria-hidden="true"])';

// Username: any text-like input preceding the password field in the same form.
const DEFAULT_USERNAME_EVAL = `(() => {
  const pw = document.querySelector('input[type="password"]:not([aria-hidden="true"])');
  if (!pw) return null;
  const form = pw.closest('form');
  const root = form ?? document;
  const candidates = root.querySelectorAll(
    'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
  );
  let chosen = null;
  for (const el of candidates) {
    if (pw.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) chosen = el;
  }
  return chosen ? buildSelectorFor(chosen) : null;

  function buildSelectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return 'input[name="' + CSS.escape(el.name) + '"]';
    return 'input:not([type=password])';
  }
})()`;

/**
 * Read both field values atomically via the native HTMLInputElement.value
 * descriptor. React's controlled-component override on the instance is
 * bypassed so we see what the PM actually wrote.
 */
async function readFieldValues(
  page: Page,
  passwordSelector: string,
  usernameSelector: string | null,
): Promise<{ hasPassword: boolean; hasUsername: boolean }> {
  return page.evaluate(
    ({ pwSel, unSel }) => {
      const nativeGetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.get;
      const pw = document.querySelector(pwSel) as HTMLInputElement | null;
      const un = unSel
        ? (document.querySelector(unSel) as HTMLInputElement | null)
        : null;
      const read = (el: HTMLInputElement | null) =>
        el && nativeGetter ? nativeGetter.call(el) : (el?.value ?? '');
      const pwVal = read(pw) as string;
      const unVal = read(un) as string;
      return { hasPassword: pwVal.length > 0, hasUsername: unVal.length > 0 };
    },
    { pwSel: passwordSelector, unSel: usernameSelector },
  );
}

async function waitForPasswordField(
  page: Page,
  selector: string,
  budgetMs: number,
): Promise<Locator | null> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'attached', timeout: budgetMs });
    return loc;
  } catch {
    return null;
  }
}

async function resolveUsernameSelector(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(DEFAULT_USERNAME_EVAL);
  } catch {
    return null;
  }
}

/**
 * Poll for "filled" with two-consecutive-hits stability. Returns the result
 * snapshot at the moment both hits are confirmed, or null on timeout.
 */
async function pollUntilFilled(
  page: Page,
  passwordSelector: string,
  usernameSelector: string | null,
  budgetMs: number,
  pollMs: number,
): Promise<{ hasPassword: boolean; hasUsername: boolean } | null> {
  const deadline = Date.now() + budgetMs;
  let prevFilled = false;
  while (Date.now() < deadline) {
    const snap = await readFieldValues(page, passwordSelector, usernameSelector);
    if (snap.hasPassword) {
      if (prevFilled) return snap;
      prevFilled = true;
    } else {
      prevFilled = false;
    }
    await sleep(pollMs);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runPmAutofillPreflight(
  opts: PreflightOptions,
): Promise<PreflightResult> {
  const started = Date.now();
  const budget = { ...DEFAULT_BUDGET, ...(opts.budgetMs ?? {}) };
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const log = opts.logger ?? (() => {});
  const passwordSelector = opts.passwordSelector ?? DEFAULT_PASSWORD_SELECTOR;

  log(
    `[pm-preflight] start passwordSelector='${passwordSelector}' `
      + `budget=${budget.baseline + budget.refresh + budget.focusClick}ms`,
  );

  let pwLoc = await waitForPasswordField(opts.page, passwordSelector, budget.noFormWait);
  if (!pwLoc) {
    const elapsedMs = Date.now() - started;
    log(`[pm-preflight] no-form elapsedMs=${elapsedMs}`);
    return { status: 'no-form', elapsedMs };
  }

  const usernameSelector = opts.usernameSelector ?? (await resolveUsernameSelector(opts.page));

  const tried: Technique[] = [];

  // Rung 1: BASELINE
  tried.push('baseline');
  {
    const snap = await pollUntilFilled(opts.page, passwordSelector, usernameSelector, budget.baseline, pollMs);
    if (snap) {
      const elapsedMs = Date.now() - started;
      log(`[pm-preflight] rung=baseline elapsedMs=${elapsedMs} result=filled hasUsername=${snap.hasUsername}`);
      log(`[pm-preflight] success technique=baseline totalMs=${elapsedMs}`);
      return { status: 'filled', technique: 'baseline', elapsedMs, ...snap };
    }
    log(`[pm-preflight] rung=baseline elapsedMs=${Date.now() - started} result=empty`);
  }

  // Rung 2: REFRESH
  tried.push('refresh');
  {
    try {
      await opts.page.reload({ waitUntil: 'load', timeout: budget.refresh });
    } catch (err) {
      log(`[pm-preflight] rung=refresh reload-failed err=${(err as Error).message}`);
      // fall through to rung 3
    }
    pwLoc = await waitForPasswordField(opts.page, passwordSelector, budget.noFormWait);
    if (!pwLoc) {
      const elapsedMs = Date.now() - started;
      log(`[pm-preflight] rung=refresh reloaded no-form elapsedMs=${elapsedMs}`);
      return { status: 'no-form', elapsedMs };
    }
    const snap = await pollUntilFilled(opts.page, passwordSelector, usernameSelector, budget.refresh, pollMs);
    if (snap) {
      const elapsedMs = Date.now() - started;
      log(`[pm-preflight] rung=refresh elapsedMs=${elapsedMs} result=filled hasUsername=${snap.hasUsername}`);
      log(`[pm-preflight] success technique=refresh totalMs=${elapsedMs}`);
      return { status: 'filled', technique: 'refresh', elapsedMs, ...snap };
    }
    log(`[pm-preflight] rung=refresh elapsedMs=${Date.now() - started} result=empty`);
  }

  // Rung 3: FOCUS-CLICK
  tried.push('focus-click');
  let clicked = false;
  if (usernameSelector) {
    try {
      await opts.page.locator(usernameSelector).first().scrollIntoViewIfNeeded({ timeout: 1000 });
      const box = await opts.page.locator(usernameSelector).first().boundingBox();
      if (box) {
        await opts.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        log(`[pm-preflight] rung=focus-click coords=(${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)})`);
        clicked = true;
      } else {
        log(`[pm-preflight] rung=focus-click no-bounding-box`);
      }
    } catch (err) {
      log(`[pm-preflight] rung=focus-click click-failed err=${(err as Error).message}`);
    }
  } else {
    log(`[pm-preflight] rung=focus-click skipped=no-username-selector`);
  }
  if (clicked) {
    const snap = await pollUntilFilled(opts.page, passwordSelector, usernameSelector, budget.focusClick, pollMs);
    if (snap) {
      const elapsedMs = Date.now() - started;
      log(`[pm-preflight] rung=focus-click elapsedMs=${elapsedMs} result=filled hasUsername=${snap.hasUsername}`);
      log(`[pm-preflight] success technique=focus-click totalMs=${elapsedMs}`);
      return { status: 'filled', technique: 'focus-click', elapsedMs, ...snap };
    }
  }

  const elapsedMs = Date.now() - started;
  log(`[pm-preflight] giveup tried=[${tried.join(',')}] totalMs=${elapsedMs}`);
  return { status: 'empty', triedTechniques: tried, elapsedMs };
}
