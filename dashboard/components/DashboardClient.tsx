'use client';

import { useEffect, useReducer, useRef } from 'react';
import { useWebSocket, DashboardEvent } from '../lib/useWebSocket';
import Room, { ActiveAgent } from './Room';

// ─── Room definitions ──────────────────────────────────────────────────────
const ROOMS = [
  {
    id: 'office',
    title: 'Office',
    icon: '🏢',
    agentIds: ['brain:sonnet', 'brain:opus', 'brain:haiku', 'discord', 'trainer'],
  },
  {
    id: 'engineering',
    title: 'Engineering Bay',
    icon: '⚙️',
    agentIds: ['builder', 'discord'],
  },
  {
    id: 'research',
    title: 'Research Lab',
    icon: '🔬',
    agentIds: ['research', 'product-pulse'],
  },
  {
    id: 'design',
    title: 'Design Studio',
    icon: '🎨',
    agentIds: [],
  },
  {
    id: 'inbox',
    title: 'Inbox',
    icon: '📧',
    agentIds: ['inbox-monitor'],
  },
] as const;

type RoomId = typeof ROOMS[number]['id'];

// ─── State ─────────────────────────────────────────────────────────────────
interface AgentState {
  task: string;
  isWorking: boolean;
  room: RoomId;
  updatedAt: number;
}

interface DashboardState {
  agents: Record<string, AgentState>;
  roomActivity: Record<RoomId, string>;
  ticker: Array<{ ts: string; type: string; room: string; task: string }>;
}

const initialState: DashboardState = {
  agents: {},
  roomActivity: {
    office: '',
    engineering: '',
    research: '',
    design: '',
    inbox: '',
  },
  ticker: [],
};

type Action = { type: 'EVENT'; event: DashboardEvent };

const IDLE_TIMEOUT_MS = 15_000; // agent goes idle after 15s without an update

function roomForEvent(event: DashboardEvent): RoomId {
  const r = event.room as RoomId | undefined;
  const valid: RoomId[] = ['office', 'engineering', 'research', 'design', 'inbox'];
  return r && valid.includes(r) ? r : 'office';
}

function reducer(state: DashboardState, action: Action): DashboardState {
  const { event } = action;
  const now = Date.now();
  const room = roomForEvent(event);
  const agentId = event.agent ?? 'jarvis';
  const task = event.task ?? '';

  const tickEntry = {
    ts: new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: event.type,
    room,
    task: task.slice(0, 80),
  };

  const newTicker = [tickEntry, ...state.ticker].slice(0, 40);

  // Determine working state
  const isWorking = ![
    'agent_idle',
    'cron_complete',
    'training_complete',
    'build_complete',
    'research_complete',
  ].includes(event.type);

  const updatedAgents = {
    ...state.agents,
    [agentId]: {
      task,
      isWorking,
      room,
      updatedAt: now,
    } satisfies AgentState,
  };

  const updatedRoomActivity = {
    ...state.roomActivity,
    [room]: task.slice(0, 60) || event.type,
  };

  return {
    agents: updatedAgents,
    roomActivity: updatedRoomActivity,
    ticker: newTicker,
  };
}

// ─── Component ─────────────────────────────────────────────────────────────
interface DashboardClientProps {
  wsUrl: string;
}

export default function DashboardClient({ wsUrl }: DashboardClientProps) {
  const { connected, lastEvent, events } = useWebSocket(wsUrl || undefined);
  const [state, dispatch] = useReducer(reducer, initialState);
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Dispatch events into reducer
  useEffect(() => {
    if (!lastEvent) return;
    dispatch({ type: 'EVENT', event: lastEvent });
  }, [lastEvent]);

  // Auto-idle agents after IDLE_TIMEOUT_MS
  useEffect(() => {
    Object.entries(state.agents).forEach(([id, agent]) => {
      if (!agent.isWorking) return;
      if (idleTimers.current[id]) clearTimeout(idleTimers.current[id]);
      idleTimers.current[id] = setTimeout(() => {
        dispatch({
          type: 'EVENT',
          event: {
            type: 'agent_idle',
            room: agent.room,
            agent: id,
            task: '',
            timestamp: new Date().toISOString(),
          },
        });
      }, IDLE_TIMEOUT_MS);
    });
  }, [state.agents]);

  // Build per-room agent lists
  function agentsForRoom(roomId: RoomId): ActiveAgent[] {
    return Object.entries(state.agents)
      .filter(([, a]) => a.room === roomId)
      .map(([id, a]) => ({
        id,
        task: a.task,
        isWorking: a.isWorking,
        updatedAt: a.updatedAt,
      }));
  }

  // Ticker items (doubled for seamless scroll)
  const tickerItems = [...state.ticker, ...state.ticker];

  return (
    <div className="hq-shell scanlines">
      {/* Header */}
      <header className="hq-header">
        <h1>JARVIS HQ</h1>
        <div className="hq-status">
          <div className={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? 'LIVE' : 'RECONNECTING…'}</span>
          <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>|</span>
          <span>{Object.keys(state.agents).length} agent{Object.keys(state.agents).length !== 1 ? 's' : ''} tracked</span>
        </div>
      </header>

      {/* Room grid */}
      <main className="hq-grid">
        {ROOMS.map(room => (
          <Room
            key={room.id}
            id={room.id}
            title={room.title}
            icon={room.icon}
            agents={agentsForRoom(room.id as RoomId)}
            lastActivity={state.roomActivity[room.id as RoomId] ?? ''}
          />
        ))}
      </main>

      {/* Event ticker */}
      {state.ticker.length > 0 && (
        <div className="event-ticker" aria-live="polite" aria-atomic="false">
          <div className="event-ticker-inner">
            {tickerItems.map((item, i) => (
              <span key={i} className="ticker-item">
                <span className="ts">{item.ts}</span>
                <span className="ev">[{item.type}]</span>
                {item.room && <span style={{ color: 'var(--accent)', marginRight: 4 }}>{item.room}</span>}
                <span>{item.task || item.type}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
