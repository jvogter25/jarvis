import { getProjects } from '../memory/supabase.js';

interface OvernightSession {
  active: boolean;
  instructions: string;
  startedAt: Date;
  channelId: string;
}

let overnightSession: OvernightSession | null = null;

export function activateOvernightMode(channelId: string, instructions: string): void {
  overnightSession = { active: true, instructions, startedAt: new Date(), channelId };
  console.log(`Overnight mode activated: ${instructions}`);
}

export function deactivateOvernightMode(): void {
  overnightSession = null;
}

export function isOvernightActive(): boolean {
  return overnightSession?.active ?? false;
}

export function getOvernightInstructions(): string {
  return overnightSession?.instructions ?? '';
}

export function detectOvernightTrigger(text: string): string | null {
  const patterns = [
    /^overnight[,:]?\s+(.+)/i,
    /^tonight[,:]?\s+(.+)/i,
    /while i(?:'m)? (?:sleeping|asleep|away)[,:]?\s+(.+)/i,
    /run overnight[,:]?\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[match.length - 1].trim();
  }
  return null;
}

export async function generateOvernightSummary(): Promise<string> {
  const [stagingProjects, liveProjects] = await Promise.all([
    getProjects('staging'),
    getProjects('live'),
  ]);

  const recentLive = liveProjects.filter(p => {
    const updatedAt = new Date(p.updated_at);
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    return updatedAt > eightHoursAgo;
  });

  if (stagingProjects.length === 0 && recentLive.length === 0) return '';

  const lines: string[] = ['**Overnight Build Summary:**'];

  if (recentLive.length > 0) {
    lines.push('\n**Shipped:**');
    for (const p of recentLive) {
      lines.push(`• **${p.name}** — ${p.production_url ?? 'live'}`);
    }
  }

  if (stagingProjects.length > 0) {
    lines.push('\n**Staging — needs your approval:**');
    for (const p of stagingProjects) {
      lines.push(`• **${p.name}** — ${p.staging_url ?? 'deploying...'}`);
      lines.push(`  Say "ship ${p.slug}" to go live.`);
    }
  }

  return lines.join('\n');
}
