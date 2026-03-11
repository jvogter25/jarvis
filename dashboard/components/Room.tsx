'use client';

import AgentSprite from './AgentSprite';

export interface ActiveAgent {
  id: string;
  task: string;
  isWorking: boolean;
  updatedAt: number;
}

interface RoomProps {
  id: string;
  title: string;
  icon: string;
  agents: ActiveAgent[];
  lastActivity: string;
}

export default function Room({ id, title, icon, agents, lastActivity }: RoomProps) {
  return (
    <div className="room" data-room={id}>
      <div className="room-header">
        <span className="room-icon">{icon}</span>
        <span className="room-title">{title}</span>
        {lastActivity && (
          <span className="room-activity" title={lastActivity}>{lastActivity}</span>
        )}
      </div>
      <div className="room-floor" aria-hidden="true" />
      <div className="room-stage">
        {agents.map(agent => (
          <AgentSprite
            key={agent.id}
            agentId={agent.id}
            task={agent.task}
            isWorking={agent.isWorking}
          />
        ))}
        {agents.length === 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', alignSelf: 'center', width: '100%', textAlign: 'center' }}>
            — idle —
          </span>
        )}
      </div>
    </div>
  );
}
