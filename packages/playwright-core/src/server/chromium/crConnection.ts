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

import {  assert, eventsHelper } from '../../utils';
import { debugLogger } from '../utils/debugLogger';
import { helper } from '../helper';
import { ProtocolError } from '../protocolError';
import { SdkObject } from '../instrumentation';

import type { RegisteredListener } from '../../utils';
import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from '../transport';
import type { Protocol } from './protocol';
import type { RecentLogsCollector } from '../utils/debugLogger';
import type { ProtocolLogger } from '../types';


export const ConnectionEvents = {
  Disconnected: Symbol('ConnectionEvents.Disconnected')
};

export type ConnectionEventMap = {
  [ConnectionEvents.Disconnected]: [];
};

// CRPlaywright uses this special id to issue Browser.close command which we
// should ignore.
export const kBrowserCloseMessageId = -9999;

export class CRConnection extends SdkObject {
  private _lastId = 0;
  private readonly _transport: ConnectionTransport;
  readonly _sessions = new Map<string, CRSession>();
  private readonly _protocolLogger: ProtocolLogger;
  private readonly _browserLogsCollector: RecentLogsCollector;
  _browserDisconnectedLogs: string | undefined;
  readonly rootSession: CRSession;
  _closed = false;

  constructor(parent: SdkObject, transport: ConnectionTransport, protocolLogger: ProtocolLogger, browserLogsCollector: RecentLogsCollector) {
    super(parent, 'cr-connection');
    this.setMaxListeners(0);
    this._transport = transport;
    this._protocolLogger = protocolLogger;
    this._browserLogsCollector = browserLogsCollector;
    this.rootSession = new CRSession(this, null, '');
    this._sessions.set('', this.rootSession);
    this._transport.onmessage = this._onMessage.bind(this);
    // onclose should be set last, since it can be immediately called.
    this._transport.onclose = this._onClose.bind(this);
  }

  _rawSend(sessionId: string, method: string, params: any): number {
    const id = ++this._lastId;
    const message: ProtocolRequest = { id, method, params };
    if (sessionId)
      message.sessionId = sessionId;
    this._protocolLogger('send', message);
    this._transport.send(message);
    return id;
  }

  async _onMessage(message: ProtocolResponse) {
    this._protocolLogger('receive', message);
    if (message.id === kBrowserCloseMessageId)
      return;
    const session = this._sessions.get(message.sessionId || '');
    if (session)
      session._onMessage(message);
  }

  _onClose(reason?: string) {
    this._closed = true;
    this._transport.onmessage = undefined;
    this._transport.onclose = undefined;
    this._browserDisconnectedLogs = helper.formatBrowserLogs(this._browserLogsCollector.recentLogs(), reason);
    this.rootSession.dispose();
    Promise.resolve().then(() => this.emit(ConnectionEvents.Disconnected));
  }

  close() {
    if (!this._closed)
      this._transport.close();
  }

  async createBrowserSession(): Promise<CDPSession> {
    const { sessionId } = await this.rootSession.send('Target.attachToBrowserTarget');
    return new CDPSession(this.rootSession, sessionId);
  }
}

type SessionEventListener = (method: string, params?: Object) => void;

export class CRSession extends SdkObject<Protocol.EventMap & ConnectionEventMap> {
  private readonly _connection: CRConnection;
  private _eventListener?: SessionEventListener;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: ProtocolError) => void, error: ProtocolError }>();
  private readonly _sessionId: string;
  private readonly _parentSession: CRSession | null;
  private _crashed: boolean = false;
  private _closed = false;

  constructor(connection: CRConnection, parentSession: CRSession | null, sessionId: string, eventListener?: SessionEventListener) {
    super(connection, 'cr-session');
    this.setMaxListeners(0);
    this._connection = connection;
    this._parentSession = parentSession;
    this._sessionId = sessionId;
    this._eventListener = eventListener;
  }

  _markAsCrashed() {
    this._crashed = true;
  }

  createChildSession(sessionId: string, eventListener?: SessionEventListener): CRSession {
    const session = new CRSession(this._connection, this, sessionId, eventListener);
    this._connection._sessions.set(sessionId, session);
    return session;
  }

  async send<T extends keyof Protocol.CommandParameters>(
    method: T,
    params?: Protocol.CommandParameters[T]
  ): Promise<Protocol.CommandReturnValues[T]> {
    if (this._crashed || this._closed || this._connection._closed || this._connection._browserDisconnectedLogs)
      throw new ProtocolError(this._crashed ? 'crashed' : 'closed', undefined, this._connection._browserDisconnectedLogs);
    const id = this._connection._rawSend(this._sessionId, method, params);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error: new ProtocolError('error', method) });
    });
  }

  _sendMayFail<T extends keyof Protocol.CommandParameters>(method: T, params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T] | void> {
    return this.send(method, params).catch((error: ProtocolError) => debugLogger.log('error', error));
  }

  _onMessage(object: ProtocolResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        callback.error.setMessage(object.error.message);
        callback.reject(callback.error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id && object.error?.code === -32001) {
      // Message to a closed session, just ignore it.
    } else {
      assert(!object.id, object?.error?.message || undefined);
      Promise.resolve().then(() => {
        if (this._eventListener)
          this._eventListener(object.method!, object.params);
        (this.emit as any)(object.method as any, object.params);
      });
    }
  }

  async detach() {
    if (this._closed)
      throw new Error(`Session already detached. Most likely the page has been closed.`);
    if (!this._parentSession)
      throw new Error('Root session cannot be closed');
    // Ideally, detaching should resume any target, but there is a bug in the backend,
    // so we must Runtime.runIfWaitingForDebugger first.
    await this._sendMayFail('Runtime.runIfWaitingForDebugger');
    await this._parentSession.send('Target.detachFromTarget', { sessionId: this._sessionId });
    this.dispose();
  }

  dispose() {
    this._closed = true;
    this._connection._sessions.delete(this._sessionId);
    for (const callback of this._callbacks.values()) {
      callback.error.setMessage(`Internal server error, session closed.`);
      callback.error.type = this._crashed ? 'crashed' : 'closed';
      callback.error.logs = this._connection._browserDisconnectedLogs;
      callback.reject(callback.error);
    }
    this._callbacks.clear();
  }

  /**
   * Lazily discover an execution context ID and emit a synthetic
   * Runtime.executionContextCreated event so that Playwright's frame
   * model is populated without ever calling Runtime.enable.
   */
  async __re__emitExecutionContext(world: 'main' | 'utility', targetId: string, frame: { _id: string }, worldName?: string): Promise<void> {
    let contextId: number;
    if (world === 'main') {
      contextId = await this.__re__getMainWorld(frame._id, targetId);
    } else {
      contextId = await this.__re__getIsolatedWorld(frame._id, worldName || '__chromium_utility_default');
    }
    // Emit synthetic Runtime.executionContextCreated so CRPage._onExecutionContextCreated picks it up
    const syntheticEvent: any = {
      context: {
        id: contextId,
        origin: '',
        name: world === 'utility' ? worldName : '',
        auxData: {
          isDefault: world === 'main',
          type: 'default',
          frameId: frame._id,
        },
      },
    };
    Promise.resolve().then(() => {
      (this.emit as any)('Runtime.executionContextCreated', syntheticEvent);
    });
  }

  /**
   * Discover the main world execution context ID for a frame without
   * calling Runtime.enable. Uses Runtime.addBinding + Page.createIsolatedWorld
   * to trigger a Runtime.bindingCalled event that reveals the context ID.
   */
  async __re__getMainWorld(frameId: string, targetId: string): Promise<number> {
    const bindingName = '__re__' + Math.random().toString(36).slice(2, 15);

    // Add a temporary binding — this makes Chrome fire Runtime.bindingCalled
    // when the binding is invoked, even without Runtime.enable
    await this.send('Runtime.addBinding' as any, { name: bindingName });

    const contextIdPromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for main world context discovery'));
      }, 5000);

      const onBindingCalled = (event: any) => {
        if (event.name === bindingName) {
          cleanup();
          resolve(event.executionContextId);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener('Runtime.bindingCalled' as any, onBindingCalled);
      };

      this.on('Runtime.bindingCalled' as any, onBindingCalled);
    });

    // Create an isolated world to run a script that calls the binding in the main world
    const { executionContextId: isolatedContextId } = await this.send('Page.createIsolatedWorld' as any, {
      frameId,
      worldName: '__re__probe_' + Math.random().toString(36).slice(2, 10),
      grantUniveralAccess: true,
    });

    // From the isolated world, invoke the binding in the main world.
    // The isolated world has access to the main world's bindings via the global scope.
    await this.send('Runtime.evaluate' as any, {
      expression: `window['${bindingName}']('probe')`,
      contextId: isolatedContextId,
      awaitPromise: false,
    }).catch(() => {});

    const contextId = await contextIdPromise;

    // Clean up: remove the temporary binding
    await this.send('Runtime.removeBinding' as any, { name: bindingName }).catch(() => {});

    return contextId;
  }

  /**
   * Get or create an isolated world execution context for a frame.
   * This is straightforward — Page.createIsolatedWorld returns the context ID directly.
   */
  async __re__getIsolatedWorld(frameId: string, worldName: string): Promise<number> {
    const { executionContextId } = await this.send('Page.createIsolatedWorld' as any, {
      frameId,
      worldName,
      grantUniveralAccess: true,
    });
    return executionContextId;
  }
}

export class CDPSession extends SdkObject {
  static Events = {
    Event: 'event',
    Closed: 'close',
  };

  private _session: CRSession;
  private _listeners: RegisteredListener[] = [];

  constructor(parentSession: CRSession, sessionId: string) {
    super(parentSession, 'cdp-session');
    this._session = parentSession.createChildSession(sessionId, (method, params) => this.emit(CDPSession.Events.Event, { method, params }));
    this._listeners = [eventsHelper.addEventListener(parentSession, 'Target.detachedFromTarget', (event: Protocol.Target.detachedFromTargetPayload) => {
      if (event.sessionId === sessionId)
        this._onClose();
    })];
  }

  async send(method: string, params?: any) {
    return await this._session.send(method as any, params);
  }

  async detach() {
    return await this._session.detach();
  }

  async attachToTarget(targetId: string) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new CDPSession(this._session, sessionId);
  }

  private _onClose() {
    eventsHelper.removeEventListeners(this._listeners);
    this._session.dispose();
    this.emit(CDPSession.Events.Closed);
  }
}
