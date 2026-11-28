/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBackgroundCompletionBehavior } from './config.js';

describe('resolveBackgroundCompletionBehavior', () => {
  afterEach(() => {
    delete process.env['AFOT_BG_COMPLETION'];
  });
  it('defaults to inject (agent resumes when a background command ends)', () => {
    expect(resolveBackgroundCompletionBehavior(undefined)).toBe('inject');
    expect(resolveBackgroundCompletionBehavior('silent')).toBe('inject');
  });
  it('honors notify setting', () => {
    expect(resolveBackgroundCompletionBehavior('notify')).toBe('notify');
  });
  it('env override wins; off disables', () => {
    process.env['AFOT_BG_COMPLETION'] = 'off';
    expect(resolveBackgroundCompletionBehavior('notify')).toBe('silent');
    process.env['AFOT_BG_COMPLETION'] = 'notify';
    expect(resolveBackgroundCompletionBehavior(undefined)).toBe('notify');
  });
});
