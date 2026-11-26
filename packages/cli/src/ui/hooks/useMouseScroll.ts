/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBoundingBox, type DOMElement } from 'ink';
import type React from 'react';
import { useCallback, useRef } from 'react';
import { useMouse, type MouseEvent } from '../contexts/MouseContext.js';

export type MouseScrollDirection = 'up' | 'down';

/**
 * Calls `handler` when the mouse wheel is scrolled over the container.
 */
export const useMouseScroll = (
  containerRef: React.RefObject<DOMElement | null>,
  handler: (
    direction: MouseScrollDirection,
    relativeX: number,
    relativeY: number,
  ) => void,
  options: { isActive?: boolean } = {},
) => {
  const { isActive = true } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const onMouse = useCallback(
    (event: MouseEvent) => {
      if (event.name !== 'scroll-up' && event.name !== 'scroll-down') return;
      if (!containerRef.current) return;
      const { x, y, width, height } = getBoundingBox(containerRef.current);
      // Terminal mouse events are 1-based, Ink layout is 0-based.
      const mouseX = event.col - 1;
      const mouseY = event.row - 1;

      const relativeX = mouseX - x;
      const relativeY = mouseY - y;

      if (
        relativeX >= 0 &&
        relativeX < width &&
        relativeY >= 0 &&
        relativeY < height
      ) {
        handlerRef.current(
          event.name === 'scroll-up' ? 'up' : 'down',
          relativeX,
          relativeY,
        );
      }
    },
    [containerRef],
  );

  useMouse(onMouse, { isActive });
};
