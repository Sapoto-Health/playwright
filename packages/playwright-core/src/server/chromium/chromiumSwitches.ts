/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// No dependencies as it is used from the Electron loader.

const disabledFeatures = (assistantMode?: boolean) => [
  // See https://github.com/microsoft/playwright/issues/14047
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  // See https://github.com/microsoft/playwright/issues/38568
  'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose',
  // See https://github.com/microsoft/playwright/pull/13854
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  // See https://github.com/microsoft/playwright/pull/27605
  'HttpsUpgrades',
  // Hides the Lens feature in the URL address bar. Its not working in unofficial builds.
  'LensOverlay',
  // See https://github.com/microsoft/playwright/pull/8162
  'MediaRouter',
  // See https://github.com/microsoft/playwright/issues/28023
  'PaintHolding',
  // See https://github.com/microsoft/playwright/issues/32230
  'ThirdPartyStoragePartitioning',
  // See https://github.com/microsoft/playwright/issues/16126
  'Translate',
  // See https://issues.chromium.org/u/1/issues/435410220
  'AutoDeElevate',
  // Prevents downloading optimization hints on startup.
  'OptimizationHints',
  assistantMode ? 'AutomationControlled' : '',
].filter(Boolean);

/**
 * Minimal disabled features for assistantMode stealth.
 * Only includes features required for Playwright stability or core stealth.
 * Omits features that real Chrome has enabled (Translate, HttpsUpgrades,
 * MediaRouter, GlobalMediaControls, etc.) to reduce fingerprint divergence.
 */
const stealthDisabledFeatures = () => [
  'AutomationControlled',
  // Playwright stability — required for correct beforeunload handling
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  // Playwright stability — required for correct event dispatch
  'BoundaryEventDispatchTracksNodeRemoval',
  // Persistent profiles must survive browser close
  'DestroyProfileOnBrowserClose',
  // Playwright stability — required for consistent page rendering
  'PaintHolding',
  // Chromium stability on Windows
  'AutoDeElevate',
  // Prevents unnecessary network activity on startup
  'OptimizationHints',
];

/**
 * Minimal Chrome flags for assistantMode (stealth).
 * Goal: look as close to a normal Chrome launch as possible.
 * Only includes flags required for CDP operation, Playwright stability,
 * or crash prevention. Omits flags whose side effects are detectable
 * by antibot systems (field trial config, background networking,
 * extensions, color profile, keychain, etc.).
 */
const stealthSwitches = () => [
  // --- Required for CDP / Playwright reliability ---
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache', // Required for Playwright navigation model (page.goBack)
  '--disable-breakpad', // No crash reporter needed
  '--disable-component-update', // Avoid network noise during agent runs
  '--disable-dev-shm-usage', // Prevent /dev/shm crashes on Linux
  '--disable-hang-monitor', // Prevent "page unresponsive" dialogs
  '--disable-ipc-flooding-protection', // Required for high-throughput CDP
  '--disable-popup-blocking', // Agent needs to handle popups
  '--disable-prompt-on-repost', // Avoid confirmation dialogs on POST resubmit
  '--disable-renderer-backgrounding', // Keep renderers active
  '--allow-pre-commit-input',

  // --- Required for correct behavior ---
  '--no-first-run', // Skip first-run dialogs / setup
  '--export-tagged-pdf', // PDF download support
  '--disable-infobars', // Hide "Chrome is being controlled" infobar
  '--edge-skip-compat-layer-relaunch', // Prevent Edge restart on Windows losing CDP fds
  '--password-store=basic', // Prevent macOS Keychain password prompts (not web-detectable)
  '--use-mock-keychain', // Same — avoids system keychain access (not web-detectable)

  // --- Feature flags ---
  '--disable-features=' + stealthDisabledFeatures().join(','),
  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? '' : '--enable-features=CDPScreenshotNewSurface',

  // --- Explicitly NOT enabling automation ---
  // '--enable-automation' is omitted — assistantMode always skips it
].filter(Boolean);

export const chromiumSwitches = (assistantMode?: boolean, channel?: string, android?: boolean) => {
  if (assistantMode)
    return stealthSwitches();

  return [
    '--disable-field-trial-config', // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/README.md
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-back-forward-cache', // Avoids surprises like main request not being intercepted during page.goBack().
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update', // Avoids unneeded network activity after startup.
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=' + disabledFeatures(assistantMode).join(','),
    process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? '' : '--enable-features=CDPScreenshotNewSurface',
    '--allow-pre-commit-input',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    // See https://chromium-review.googlesource.com/c/chromium/src/+/2436773
    '--no-service-autorun',
    '--export-tagged-pdf',
    // https://chromium-review.googlesource.com/c/chromium/src/+/4853540
    '--disable-search-engine-choice-screen',
    // https://issues.chromium.org/41491762
    '--unsafely-disable-devtools-self-xss-warnings',
    // Edge can potentially restart on Windows (msRelaunchNoCompatLayer) which looses its file descriptors (stdout/stderr) and CDP (3/4). Disable until fixed upstream.
    '--edge-skip-compat-layer-relaunch',
    '--enable-automation',
    // This disables Chrome for Testing infobar that is visible in the persistent context.
    // The switch is ignored everywhere else, including Chromium/Chrome/Edge.
    '--disable-infobars',
    // Less annoying popups.
    '--disable-search-engine-choice-screen',
    // Prevents the "three dots" menu crash in IdentityManager::HasPrimaryAccount for ephemeral contexts.
    android ? '' : '--disable-sync',
  ].filter(Boolean);
};
