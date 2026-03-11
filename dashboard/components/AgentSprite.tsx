'use client';

import { useState, useEffect } from 'react';

/**
 * Sprite tile coordinates in the Kenney 1-Bit Pack tilemap_packed.png.
 * Each tile is 16×16 px natively, rendered at 3× (48×48 px).
 *
 * The sheet is 49 tiles wide × 128 tiles tall.
 * background-position = -(col × 48)px  -(row × 48)px
 *
 * Adjust col/row values here to remap to different tilemap positions
 * once you've verified the actual sprite sheet layout.
 */
export const SPRITE_TILES: Record<string, { col: number; row: number }> = {
  // Agents keyed by identifier (matches `agent` field in DashboardEvent)
  'brain:sonnet':    { col: 13, row: 26 },
  'brain:opus':      { col: 14, row: 26 },
  'brain:haiku':     { col: 15, row: 26 },
  discord:           { col: 16, row: 26 },
  builder:           { col: 17, row: 26 },
  'inbox-monitor':   { col: 18, row: 26 },
  'product-pulse':   { col: 19, row: 26 },
  trainer:           { col: 20, row: 26 },
  research:          { col: 21, row: 26 },
  // fallback
  default:           { col: 26, row: 27 },
};

/** Map agent id → CSS class for the sprite tile */
function getSpriteClass(agentId: string): string {
  const key = agentId.startsWith('brain:') ? agentId : agentId.split(':')[0];
  const map: Record<string, string> = {
    'brain:sonnet':  'sprite-brain',
    'brain:opus':    'sprite-brain',
    'brain:haiku':   'sprite-brain',
    discord:         'sprite-engineer',
    builder:         'sprite-builder',
    'inbox-monitor': 'sprite-inbox',
    'product-pulse': 'sprite-researcher',
    trainer:         'sprite-trainer',
    research:        'sprite-researcher',
  };
  return map[key] ?? 'sprite-brain';
}

interface AgentSpriteProps {
  agentId: string;
  task: string;
  isWorking: boolean;
}

export default function AgentSprite({ agentId, task, isWorking }: AgentSpriteProps) {
  const spriteClass = getSpriteClass(agentId);
  const animClass = isWorking ? 'working' : 'idle';
  // Short display name
  const label = agentId.replace('brain:', 'AI:').replace('inbox-monitor', 'inbox').replace('product-pulse', 'pulse');

  return (
    <div className="agent-wrap">
      <div className={`sprite ${spriteClass} ${animClass}`} aria-label={agentId} />
      <span className="agent-label">{label}</span>
      {task && (
        <div className="tooltip">{task}</div>
      )}
    </div>
  );
}
