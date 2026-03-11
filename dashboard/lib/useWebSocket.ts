'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export interface DashboardEvent {
  type: string;
  room?: string;
  agent?: string;
  task?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface UseWebSocketResult {
  connected: boolean;
  lastEvent: DashboardEvent | null;
  events: DashboardEvent[];
}

const MAX_EVENTS = 60;

export function useWebSocket(url: string | undefined): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<DashboardEvent | null>(null);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!url) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as DashboardEvent;
          if (event.type === 'connected') return;
          setLastEvent(event);
          setEvents(prev => [event, ...prev].slice(0, MAX_EVENTS));
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        // Reconnect after 3s
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      reconnectTimer.current = setTimeout(connect, 5000);
    }
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, lastEvent, events };
}
