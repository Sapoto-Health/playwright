/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import * as playwright from 'playwright-core';
import { registryDirectory } from 'playwright-core/lib/server/registry/index';
import { startTraceViewerServer } from 'playwright-core/lib/server';
import { logUnhandledError, testDebug } from '../log';
import { outputFile } from './config';
import { firstRootPath } from '../sdk/server';

import type { FullConfig } from './config';
import type { LaunchOptions, BrowserContextOptions } from '../../../../playwright-core/src/client/types';
import type { ClientInfo } from '../sdk/server';

export function contextFactory(config: FullConfig): BrowserContextFactory {
  if (config.sharedBrowserContext)
    return SharedContextFactory.create(config);
  if (config.browser.remoteEndpoint)
    return new RemoteContextFactory(config);
  if (config.browser.cdpEndpoint)
    return new CdpContextFactory(config);
  if (config.browser.isolated)
    return new IsolatedContextFactory(config);
  return new PersistentContextFactory(config);
}

export type BrowserContextFactoryResult = {
  browserContext: playwright.BrowserContext;
  close: () => Promise<void>;
};

type CreateContextOptions = {
  toolName?: string;
};

export interface BrowserContextFactory {
  createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, options: CreateContextOptions): Promise<BrowserContextFactoryResult>;
}

export function identityBrowserContextFactory(browserContext: playwright.BrowserContext): BrowserContextFactory {
  return {
    createContext: async (clientInfo: ClientInfo, abortSignal: AbortSignal, options: CreateContextOptions) => {
      return {
        browserContext,
        close: async () => {}
      };
    }
  };
}

class BaseContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  private _logName: string;
  protected _browserPromise: Promise<playwright.Browser> | undefined;

  constructor(name: string, config: FullConfig) {
    this._logName = name;
    this.config = config;
  }

  protected async _obtainBrowser(clientInfo: ClientInfo, options: CreateContextOptions): Promise<playwright.Browser> {
    if (this._browserPromise)
      return this._browserPromise;
    testDebug(`obtain browser (${this._logName})`);
    this._browserPromise = this._doObtainBrowser(clientInfo, options);
    void this._browserPromise.then(browser => {
      browser.on('disconnected', () => {
        this._browserPromise = undefined;
      });
    }).catch(() => {
      this._browserPromise = undefined;
    });
    return this._browserPromise;
  }

  protected async _doObtainBrowser(clientInfo: ClientInfo, options: CreateContextOptions): Promise<playwright.Browser> {
    throw new Error('Not implemented');
  }

  async createContext(clientInfo: ClientInfo, _: AbortSignal, options: CreateContextOptions): Promise<BrowserContextFactoryResult> {
    testDebug(`create browser context (${this._logName})`);
    const browser = await this._obtainBrowser(clientInfo, options);
    const browserContext = await this._doCreateContext(browser, clientInfo);
    await addInitScript(browserContext, this.config.browser.initScript);
    await addStealthScripts(browserContext);
    return {
      browserContext,
      close: () => this._closeBrowserContext(browserContext, browser)
    };
  }

  protected async _doCreateContext(browser: playwright.Browser, clientInfo: ClientInfo): Promise<playwright.BrowserContext> {
    throw new Error('Not implemented');
  }

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, browser: playwright.Browser) {
    testDebug(`close browser context (${this._logName})`);
    if (browser.contexts().length === 1)
      this._browserPromise = undefined;
    await browserContext.close().catch(logUnhandledError);
    if (browser.contexts().length === 0) {
      testDebug(`close browser (${this._logName})`);
      await browser.close().catch(logUnhandledError);
    }
  }
}

class IsolatedContextFactory extends BaseContextFactory {
  constructor(config: FullConfig) {
    super('isolated', config);
  }

  protected override async _doObtainBrowser(clientInfo: ClientInfo, options: CreateContextOptions): Promise<playwright.Browser> {
    await injectCdpPort(this.config.browser);
    const browserType = playwright[this.config.browser.browserName];
    const tracesDir = await computeTracesDir(this.config, clientInfo);
    if (tracesDir && this.config.saveTrace)
      await startTraceServer(this.config, tracesDir);
    return browserType.launch({
      tracesDir,
      ...this.config.browser.launchOptions,
      handleSIGINT: false,
      handleSIGTERM: false,
    }).catch(error => {
      if (error.message.includes('Executable doesn\'t exist'))
        throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
      throw error;
    });
  }

  protected override async _doCreateContext(browser: playwright.Browser, clientInfo: ClientInfo): Promise<playwright.BrowserContext> {
    return browser.newContext(await browserContextOptionsFromConfig(this.config, clientInfo));
  }
}

class CdpContextFactory extends BaseContextFactory {
  constructor(config: FullConfig) {
    super('cdp', config);
  }

  protected override async _doObtainBrowser(): Promise<playwright.Browser> {
    return playwright.chromium.connectOverCDP(this.config.browser.cdpEndpoint!, {
      headers: this.config.browser.cdpHeaders,
      timeout: this.config.browser.cdpTimeout
    });
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    return this.config.browser.isolated ? await browser.newContext() : browser.contexts()[0];
  }
}

class RemoteContextFactory extends BaseContextFactory {
  constructor(config: FullConfig) {
    super('remote', config);
  }

  protected override async _doObtainBrowser(): Promise<playwright.Browser> {
    const url = new URL(this.config.browser.remoteEndpoint!);
    url.searchParams.set('browser', this.config.browser.browserName);
    if (this.config.browser.launchOptions)
      url.searchParams.set('launch-options', JSON.stringify(this.config.browser.launchOptions));
    return playwright[this.config.browser.browserName].connect(String(url));
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    return browser.newContext();
  }
}

class PersistentContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  readonly name = 'persistent';
  readonly description = 'Create a new persistent browser context';

  private _userDataDirs = new Set<string>();

  constructor(config: FullConfig) {
    this.config = config;
  }

  async createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, options: CreateContextOptions): Promise<BrowserContextFactoryResult> {
    await injectCdpPort(this.config.browser);
    testDebug('create browser context (persistent)');
    const userDataDir = this.config.browser.userDataDir ?? await this._createUserDataDir(clientInfo);
    const tracesDir = await computeTracesDir(this.config, clientInfo);
    if (tracesDir && this.config.saveTrace)
      await startTraceServer(this.config, tracesDir);

    this._userDataDirs.add(userDataDir);
    testDebug('lock user data dir', userDataDir);

    const browserType = playwright[this.config.browser.browserName];
    for (let i = 0; i < 5; i++) {
      const launchOptions: LaunchOptions & BrowserContextOptions = {
        tracesDir,
        ...this.config.browser.launchOptions,
        ...await browserContextOptionsFromConfig(this.config, clientInfo),
        handleSIGINT: false,
        handleSIGTERM: false,
        ignoreDefaultArgs: [
          '--disable-extensions',
        ],
        assistantMode: true,
      };
      try {
        const browserContext = await browserType.launchPersistentContext(userDataDir, launchOptions);
        await addInitScript(browserContext, this.config.browser.initScript);
        await addStealthScripts(browserContext);
        const close = () => this._closeBrowserContext(browserContext, userDataDir);
        return { browserContext, close };
      } catch (error: any) {
        if (error.message.includes('Executable doesn\'t exist'))
          throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
        if (error.message.includes('cannot open shared object file: No such file or directory')) {
          const browserName = launchOptions.channel ?? this.config.browser.browserName;
          throw new Error(`Missing system dependencies required to run browser ${browserName}. Install them with: sudo npx playwright install-deps ${browserName}`);
        }
        if (error.message.includes('ProcessSingleton') ||
            // On Windows the process exits silently with code 21 when the profile is in use.
            error.message.includes('exitCode=21')) {
          // User data directory is already in use, try again.
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
  }

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, userDataDir: string) {
    testDebug('close browser context (persistent)');
    testDebug('release user data dir', userDataDir);
    await browserContext.close().catch(() => {});
    this._userDataDirs.delete(userDataDir);
    if (process.env.PWMCP_PROFILES_DIR_FOR_TEST && userDataDir.startsWith(process.env.PWMCP_PROFILES_DIR_FOR_TEST))
      await fs.promises.rm(userDataDir, { recursive: true }).catch(logUnhandledError);
    testDebug('close browser context complete (persistent)');
  }

  private async _createUserDataDir(clientInfo: ClientInfo) {
    const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
    const browserToken = this.config.browser.launchOptions?.channel ?? this.config.browser?.browserName;
    // Hesitant putting hundreds of files into the user's workspace, so using it for hashing instead.
    const rootPath = firstRootPath(clientInfo);
    const rootPathToken = rootPath ? `-${createHash(rootPath)}` : '';
    const result = path.join(dir, `mcp-${browserToken}${rootPathToken}`);
    await fs.promises.mkdir(result, { recursive: true });
    return result;
  }
}

async function injectCdpPort(browserConfig: FullConfig['browser']) {
  if (browserConfig.browserName === 'chromium')
    (browserConfig.launchOptions as any).cdpPort = await findFreePort();
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startTraceServer(config: FullConfig, tracesDir: string): Promise<string | undefined> {
  if (!config.saveTrace)
    return;

  const server = await startTraceViewerServer();
  const urlPrefix = server.urlPrefix('human-readable');
  const url = urlPrefix + '/trace/index.html?trace=' + tracesDir + '/trace.json';
  // eslint-disable-next-line no-console
  console.error('\nTrace viewer listening on ' + url);
}

function createHash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 7);
}

async function addInitScript(browserContext: playwright.BrowserContext, initScript: string[] | undefined) {
  for (const scriptPath of initScript ?? [])
    await browserContext.addInitScript({ path: path.resolve(scriptPath) });
}

async function addStealthScripts(browserContext: playwright.BrowserContext) {
  await browserContext.addInitScript(() => {
    // --- P2: Fix navigator.webdriver (prototype-level, undetectable) ---
    // Delete any instance-level override so getOwnPropertyDescriptor on navigator returns undefined
    delete Object.getPrototypeOf(navigator).webdriver;

    const webdriverGetter = (() => {
      const fn = function() { return false; };
      Object.defineProperty(fn, 'name', { value: 'get webdriver' });
      return fn;
    })();
    // Spoof Function.prototype.toString for the getter to look native
    const nativeToString = Function.prototype.toString;
    const spoofMap = new WeakMap<Function, string>();
    spoofMap.set(webdriverGetter, 'function get webdriver() { [native code] }');

    const originalToString = nativeToString.call.bind(nativeToString);
    Function.prototype.toString = function() {
      const spoof = spoofMap.get(this);
      if (spoof) return spoof;
      return originalToString(this);
    };
    // Make toString itself look native
    spoofMap.set(Function.prototype.toString, 'function toString() { [native code] }');

    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: webdriverGetter,
      configurable: true,
      enumerable: true,
    });

    // --- P2b: Clean navigator.userAgent / navigator.appVersion ---
    // Strip Electron and app identifiers that leak via CDP-connected contexts.
    // Matches the cleaning done at Electron's HTTP layer.
    const cleanUA = (ua: string) => ua
      .replace(/\s*Electron\/[\d.]+/gi, '')
      .replace(/\s*automatic-document-fetcher\/[\d.]+/gi, '')
      .replace(/\s*sapoto\/[\d.]+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const originalUA = navigator.userAgent;
    const cleanedUA = cleanUA(originalUA);
    if (cleanedUA !== originalUA) {
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: () => cleanedUA,
        configurable: true,
        enumerable: true,
      });
      // appVersion mirrors userAgent after "Mozilla/"
      const cleanedAppVersion = cleanUA(navigator.appVersion);
      if (cleanedAppVersion !== navigator.appVersion) {
        Object.defineProperty(Navigator.prototype, 'appVersion', {
          get: () => cleanedAppVersion,
          configurable: true,
          enumerable: true,
        });
      }
    }

    // --- P3a: Spoof window.chrome ---
    if (!(window as any).chrome) {
      const chrome: any = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: function getDetails() { return null; },
          getIsInstalled: function getIsInstalled() { return false; },
          installState: function installState() { return 'not_installed'; },
        },
        runtime: {
          OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update',
          },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', FUCHSIA: 'fuchsia', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
          connect: function connect() {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          },
          sendMessage: function sendMessage() {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          },
          id: undefined,
        },
        csi: function csi() { return { onloadT: Date.now(), startE: Date.now(), pageT: 0 }; },
        loadTimes: function loadTimes() {
          return {
            commitLoadTime: Date.now() / 1000,
            connectionInfo: 'h2',
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000,
            navigationType: 'Other',
            npnNegotiatedProtocol: 'h2',
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
          };
        },
      };
      (window as any).chrome = chrome;
    }

    // --- P3b: Spoof navigator.plugins ---
    if (navigator.plugins.length === 0) {
      const pluginNames = [
        'PDF Viewer',
        'Chrome PDF Viewer',
        'Chromium PDF Viewer',
        'Microsoft Edge PDF Viewer',
        'WebKit built-in PDF',
      ];

      const mimeType = {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      };

      const fakePluginArray: any[] = [];
      const fakePluginMap: Record<string, any> = {};

      for (const name of pluginNames) {
        const plugin = {
          name,
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 1,
          0: mimeType,
          item: (i: number) => (i === 0 ? mimeType : null),
          namedItem: (n: string) => (n === 'application/pdf' ? mimeType : null),
        };
        fakePluginArray.push(plugin);
        fakePluginMap[name] = plugin;
      }

      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => {
          const arr: any = [...fakePluginArray];
          arr.item = (i: number) => fakePluginArray[i] ?? null;
          arr.namedItem = (name: string) => fakePluginMap[name] ?? null;
          arr.refresh = () => {};
          return arr;
        },
        configurable: true,
        enumerable: true,
      });

      Object.defineProperty(Navigator.prototype, 'mimeTypes', {
        get: () => {
          const mimes = fakePluginArray.map(p => ({
            type: 'application/pdf',
            suffixes: 'pdf',
            description: 'Portable Document Format',
            enabledPlugin: p,
          }));
          const arr: any = [...mimes];
          arr.item = (i: number) => mimes[i] ?? null;
          arr.namedItem = (name: string) => mimes.find(m => m.type === name) ?? null;
          return arr;
        },
        configurable: true,
        enumerable: true,
      });
    }

    // --- P3c: Spoof navigator.pdfViewerEnabled ---
    if (!navigator.pdfViewerEnabled) {
      Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
        get: () => true,
        configurable: true,
        enumerable: true,
      });
    }
  });
}

export class SharedContextFactory implements BrowserContextFactory {
  private _contextPromise: Promise<BrowserContextFactoryResult> | undefined;
  private _baseFactory: BrowserContextFactory;
  private static _instance: SharedContextFactory | undefined;

  static create(config: FullConfig) {
    if (SharedContextFactory._instance)
      throw new Error('SharedContextFactory already exists');
    const baseConfig = { ...config, sharedBrowserContext: false };
    const baseFactory = contextFactory(baseConfig);
    SharedContextFactory._instance = new SharedContextFactory(baseFactory);
    return SharedContextFactory._instance;
  }

  private constructor(baseFactory: BrowserContextFactory) {
    this._baseFactory = baseFactory;
  }

  async createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, options: { toolName?: string }): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    if (!this._contextPromise) {
      testDebug('create shared browser context');
      this._contextPromise = this._baseFactory.createContext(clientInfo, abortSignal, options);
    }

    const { browserContext } = await this._contextPromise;
    testDebug(`shared context client connected`);
    return {
      browserContext,
      close: async () => {
        testDebug(`shared context client disconnected`);
      },
    };
  }

  static async dispose() {
    await SharedContextFactory._instance?._dispose();
  }

  private async _dispose() {
    const contextPromise = this._contextPromise;
    this._contextPromise = undefined;
    if (!contextPromise)
      return;
    const { close } = await contextPromise;
    await close();
  }
}

async function computeTracesDir(config: FullConfig, clientInfo: ClientInfo): Promise<string | undefined> {
  if (!config.saveTrace && !config.capabilities?.includes('devtools'))
    return;
  return await outputFile(config, clientInfo, `traces`, { origin: 'code', title: 'Collecting trace' });
}

async function browserContextOptionsFromConfig(config: FullConfig, clientInfo: ClientInfo): Promise<playwright.BrowserContextOptions> {
  const result = { ...config.browser.contextOptions };
  if (config.saveVideo) {
    const dir = await outputFile(config, clientInfo, `videos`, { origin: 'code', title: 'Saving video' });
    result.recordVideo = {
      dir,
      size: config.saveVideo,
    };
  }
  return result;
}
