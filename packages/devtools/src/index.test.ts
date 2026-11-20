/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DevTools } from './index.js';

let devTools: DevTools | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await devTools?.stop();
  devTools = undefined;
  vi.useRealTimers();
});

it('keeps a replacement session connection when the old connection closes', async () => {
  devTools = DevTools.getInstance();
  const url = await devTools.start();
  const socketUrl = url.replace(/^http/, 'ws') + '/ws';
  const oldSocket = new WebSocket(socketUrl);
  sockets.push(oldSocket);
  await new Promise<void>((resolve, reject) => {
    oldSocket.once('open', resolve);
    oldSocket.once('error', reject);
  });
  const oldRegistration = new Promise<void>((resolve) => {
    oldSocket.once('message', () => resolve());
  });
  oldSocket.send(JSON.stringify({ type: 'register', sessionId: 'session' }));
  await oldRegistration;

  const newSocket = new WebSocket(socketUrl);
  sockets.push(newSocket);
  await new Promise<void>((resolve, reject) => {
    newSocket.once('open', resolve);
    newSocket.once('error', reject);
  });
  const newRegistration = new Promise<void>((resolve) => {
    newSocket.once('message', () => resolve());
  });
  newSocket.send(JSON.stringify({ type: 'register', sessionId: 'session' }));
  await newRegistration;

  const oldClose = new Promise<void>((resolve) => {
    oldSocket.once('close', () => resolve());
  });
  oldSocket.close();
  await oldClose;

  const debuggerMessage = new Promise<string>((resolve) => {
    newSocket.once('message', (data) => resolve(data.toString()));
  });
  const response = await fetch(`${url}/api/trigger-debugger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session' }),
  });

  expect(response.status).toBe(200);
  expect(await debuggerMessage).toBe(
    JSON.stringify({ type: 'trigger-debugger' }),
  );
});

it('notifies listeners when the heartbeat removes a timed-out session', async () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  devTools = DevTools.getInstance();
  const sessionUpdates = vi.fn();
  devTools.on('session-update', sessionUpdates);
  const url = await devTools.start();
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const registration = new Promise<void>((resolve) => {
    socket.once('message', () => resolve());
  });
  socket.send(JSON.stringify({ type: 'register', sessionId: 'stale-session' }));
  await registration;
  sessionUpdates.mockClear();

  await vi.advanceTimersByTimeAsync(40000);

  expect(sessionUpdates).toHaveBeenCalledOnce();
});
