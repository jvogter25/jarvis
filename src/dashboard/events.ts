import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export type DashboardRoom = 'office' | 'engineering' | 'research' | 'design' | 'inbox';

export type DashboardEventType =
  | 'connected'
  | 'agent_active'
  | 'agent_idle'
  | 'tool_call'
  | 'message_received'
  | 'build_step'
  | 'build_complete'
  | 'cron_start'
  | 'cron_complete'
  | 'inbox_scan'
  | 'inbox_thread'
  | 'training_step'
  | 'training_complete'
  | 'research_start'
  | 'research_complete';

export interface DashboardEvent {
  type: DashboardEventType;
  room?: DashboardRoom;
  /** Agent or tool identifier shown on the sprite tooltip */
  agent?: string;
  /** Current task description shown in tooltip */
  task?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function startWebSocketServer(port = 8080): void {
  // Attach to an HTTP server so Railway can route to it via the single exposed PORT.
  // A plain WS server on a second port is unreachable from outside Railway.
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Jarvis OK');
  });

  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    console.log(`[dashboard] Client connected (${clients.size} total)`);
  });

  wss.on('error', (err) => {
    console.error('[dashboard] WebSocket server error:', err);
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[dashboard] WebSocket server listening on ws://0.0.0.0:${port}`);
  });
}

export function emitDashboardEvent(event: Omit<DashboardEvent, 'timestamp'>): void {
  if (!wss || clients.size === 0) return;
  const payload = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  }
}
