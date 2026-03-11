import { notFound } from 'next/navigation';
import DashboardClient from '../../components/DashboardClient';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Main dashboard page.
 * Auth: checks ?token= against DASHBOARD_SECRET env var (server-side).
 * WS URL: injected from NEXT_PUBLIC_WS_URL env var at build time.
 */
export default async function DashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = params.token ?? '';
  const secret = process.env.DASHBOARD_SECRET ?? '';

  if (!secret || token !== secret) {
    notFound();
  }

  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? '';

  return <DashboardClient wsUrl={wsUrl} />;
}

export const dynamic = 'force-dynamic';
