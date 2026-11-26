/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useRef, useState } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useAlternateBuffer } from '../../hooks/useAlternateBuffer.js';
import { useMouseClick } from '../../hooks/useMouseClick.js';
import { useMouseScroll } from '../../hooks/useMouseScroll.js';
import { clip } from '../../utils/monitorTimeline.js';
import { theme } from '../../semantic-colors.js';
import {
  AGENT_GLYPH,
  AGENT_STATE_LABEL,
  computeDockHeight,
  computePaneWindow,
  dockBodyRows,
  formatElapsedShort,
  formatWindowFooter,
  type AgentRow,
  type AgentRowState,
  type AgentRowWindow,
} from './agentDockModel.js';
import {
  setAgentDock,
  toggleAgentDockView,
  useAgentDock,
} from './agentDockStore.js';
import type { AgentRoster } from './useAgentRoster.js';

const ROW_COLOR: Record<AgentRowState, string> = {
  running: theme.text.accent,
  waiting: theme.status.warning,
  idle: theme.text.secondary,
  done: theme.status.success,
  failed: theme.status.error,
};

/**
 * A single line of the dock. Ink's <Text> defaults to flexShrink: 1, which
 * squashes rows into each other when the panel has a fixed height, so every
 * line is wrapped in a Box that refuses to shrink.
 */
const Line: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end">{children}</Text>
  </Box>
);

const AgentRowLine: React.FC<{ row: AgentRow; width: number }> = ({
  row,
  width,
}) => {
  const name = row.role ? `${row.name} · ${row.role}` : row.name;
  const nameWidth = Math.max(8, Math.min(24, width - 18));
  const elapsed =
    row.elapsedMs === undefined ? '' : formatElapsedShort(row.elapsedMs);
  const detailRoom = Math.max(
    0,
    width -
      nameWidth -
      AGENT_STATE_LABEL[row.state].length -
      elapsed.length -
      8,
  );
  return (
    <Line>
      <Text color={ROW_COLOR[row.state]}>{AGENT_GLYPH[row.state]} </Text>
      <Text
        bold={row.state === 'running'}
        color={row.state === 'idle' ? theme.text.secondary : theme.text.primary}
      >
        {clip(name, nameWidth)}
      </Text>
      <Text color={theme.text.secondary}>
        {'  '}
        {AGENT_STATE_LABEL[row.state]}
      </Text>
      {elapsed ? <Text color={theme.text.secondary}> {elapsed}</Text> : null}
      {row.detail && detailRoom > 3 ? (
        <Text color={theme.text.secondary}>
          {'  '}
          {clip(row.detail, detailRoom)}
        </Text>
      ) : null}
    </Line>
  );
};

interface PaneProps {
  window: AgentRowWindow;
  width: number;
  emptyLabel: string;
}

const AgentPane: React.FC<PaneProps> = ({ window, width, emptyLabel }) => {
  const footer = formatWindowFooter(window);
  if (window.visible.length === 0 && footer === null) {
    return (
      <Line>
        <Text color={theme.text.secondary}>{emptyLabel}</Text>
      </Line>
    );
  }
  return (
    <>
      {window.visible.map((row) => (
        <AgentRowLine key={row.key} row={row} width={width} />
      ))}
      {footer ? (
        <Line>
          <Text color={theme.text.secondary}>{footer}</Text>
        </Line>
      ) : null}
    </>
  );
};

const SwarmPane: React.FC<PaneProps & { roster: AgentRoster }> = ({
  window,
  width,
  emptyLabel,
  roster,
}) => {
  const footer = formatWindowFooter(window);
  return (
    <>
      {window.visible.length === 0 ? (
        <Line>
          <Text color={theme.text.secondary}>{emptyLabel}</Text>
        </Line>
      ) : (
        window.visible.map((row) => (
          <AgentRowLine key={row.key} row={row} width={width} />
        ))
      )}
      {footer ? (
        <Line>
          <Text color={theme.text.secondary}>{footer}</Text>
        </Line>
      ) : null}
      {roster.board.length > 0 ? (
        <>
          <Line>
            <Text color={theme.text.secondary}>
              board · {roster.totalPosts} post
              {roster.totalPosts === 1 ? '' : 's'}
            </Text>
          </Line>
          {roster.board.map((post) => (
            <Line key={post.seq}>
              <Text color={theme.text.secondary}>
                #{post.seq} @{post.sender}{' '}
                {clip(post.text, Math.max(4, width - 12))}
              </Text>
            </Line>
          ))}
        </>
      ) : null}
    </>
  );
};

export interface AgentDockProps {
  roster: AgentRoster;
}

/**
 * The expandable agent dock under the prompt: Subagents and the live swarm
 * roster, side by side by default. Sized to its content, capped at a third of
 * the terminal, and scrollable inside when the content does not fit.
 */
export const AgentDock: React.FC<AgentDockProps> = ({ roster }) => {
  const { open, view, pane } = useAgentDock();
  const { terminalWidth, terminalHeight } = useUIState();
  const isAlternateBuffer = useAlternateBuffer();

  const [subagentScroll, setSubagentScroll] = useState(0);
  const [swarmScroll, setSwarmScroll] = useState(0);

  const dockRef = useRef<DOMElement | null>(null);
  const subagentsRef = useRef<DOMElement | null>(null);
  const swarmRef = useRef<DOMElement | null>(null);
  const splitRef = useRef<DOMElement | null>(null);
  const closeRef = useRef<DOMElement | null>(null);

  useMouseClick(subagentsRef, () =>
    setAgentDock({ open: true, view: 'single', pane: 'subagents' }),
  );
  useMouseClick(swarmRef, () =>
    setAgentDock({ open: true, view: 'single', pane: 'swarm' }),
  );
  useMouseClick(splitRef, () => toggleAgentDockView());
  useMouseClick(closeRef, () => setAgentDock({ open: false }));

  const boardLines = roster.board.length > 0 ? 1 + roster.board.length : 0;
  const contentRows =
    view === 'split'
      ? Math.max(roster.subagents.length, roster.swarm.length + boardLines)
      : pane === 'swarm'
        ? roster.swarm.length + boardLines
        : roster.subagents.length;

  const height = computeDockHeight(contentRows, terminalHeight, {
    inline: !isAlternateBuffer,
  });
  const bodyRows = dockBodyRows(height);
  const innerWidth = Math.max(12, terminalWidth - 4);
  const leftWidth = Math.max(10, Math.floor((innerWidth - 3) / 2));

  const subagentWindow = computePaneWindow(
    roster.subagents,
    bodyRows,
    subagentScroll,
  );
  const swarmWindow = computePaneWindow(
    roster.swarm,
    Math.max(0, bodyRows - boardLines),
    swarmScroll,
  );

  useMouseScroll(
    dockRef,
    (direction, relativeX) => {
      const delta = direction === 'up' ? -1 : 1;
      const inRightPane =
        view === 'split' ? relativeX >= leftWidth : pane === 'swarm';
      if (inRightPane) {
        setSwarmScroll((current) =>
          Math.min(Math.max(0, current + delta), swarmWindow.maxOffset),
        );
      } else {
        setSubagentScroll((current) =>
          Math.min(Math.max(0, current + delta), subagentWindow.maxOffset),
        );
      }
    },
    { isActive: open },
  );

  if (!open) return null;

  const tabColor = (active: boolean) =>
    active ? theme.text.accent : theme.text.secondary;

  return (
    <Box
      ref={dockRef}
      flexDirection="column"
      flexShrink={0}
      width={terminalWidth}
      height={height}
      borderStyle="round"
      borderColor={theme.border.default}
      overflowY="hidden"
    >
      <Box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
      >
        <Box flexDirection="row" flexShrink={0}>
          <Box ref={subagentsRef} flexShrink={0}>
            <Text
              bold={view === 'single' && pane === 'subagents'}
              color={tabColor(view === 'single' && pane === 'subagents')}
            >
              Subagents
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={theme.text.secondary}> │ </Text>
          </Box>
          <Box ref={swarmRef} flexShrink={0}>
            <Text
              bold={view === 'single' && pane === 'swarm'}
              color={tabColor(view === 'single' && pane === 'swarm')}
            >
              {clip(roster.title || 'Swarm', 24)}
            </Text>
          </Box>
          {view === 'split' ? (
            <Box flexShrink={0}>
              <Text color={theme.text.secondary}> · 2 panes</Text>
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="row" flexShrink={0}>
          <Box ref={splitRef} flexShrink={0}>
            <Text color={theme.text.secondary}>
              {view === 'split' ? '⇔ split' : '⇔'}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={theme.text.secondary}> </Text>
          </Box>
          <Box ref={closeRef} flexShrink={0}>
            <Text color={theme.text.secondary}>✕</Text>
          </Box>
        </Box>
      </Box>

      {view === 'split' ? (
        <Box flexDirection="row" flexGrow={1} paddingX={1} overflowY="hidden">
          <Box
            flexDirection="column"
            flexShrink={0}
            width={leftWidth}
            overflowY="hidden"
          >
            <AgentPane
              window={subagentWindow}
              width={leftWidth}
              emptyLabel="No subagents yet"
            />
          </Box>
          <Box flexDirection="column" flexShrink={0} width={1}>
            <Text color={theme.border.default}>│</Text>
          </Box>
          <Box
            flexDirection="column"
            flexShrink={0}
            flexGrow={1}
            paddingLeft={1}
            overflowY="hidden"
          >
            <SwarmPane
              window={swarmWindow}
              width={innerWidth - leftWidth - 3}
              emptyLabel="Swarm idle"
              roster={roster}
            />
          </Box>
        </Box>
      ) : (
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingX={1}
          overflowY="hidden"
        >
          {pane === 'swarm' ? (
            <SwarmPane
              window={swarmWindow}
              width={innerWidth}
              emptyLabel="Swarm idle"
              roster={roster}
            />
          ) : (
            <AgentPane
              window={subagentWindow}
              width={innerWidth}
              emptyLabel="No subagents yet"
            />
          )}
        </Box>
      )}
    </Box>
  );
};
