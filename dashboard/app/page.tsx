import { redirect } from 'next/navigation';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Root page — auth gate.
 * Valid ?token= → redirect to /dashboard (preserving token).
 * Missing/wrong token → show 401 prompt.
 */
export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = params.token ?? '';
  const secret = process.env.DASHBOARD_SECRET ?? '';

  // If no secret configured, deny access
  if (!secret) {
    return (
      <div className="auth-page">
        <h1>JARVIS HQ</h1>
        <p>
          <code>DASHBOARD_SECRET</code> is not configured on the server.
        </p>
        <p>Set it in your Railway environment variables.</p>
      </div>
    );
  }

  if (token && token === secret) {
    redirect(`/dashboard?token=${encodeURIComponent(token)}`);
  }

  return (
    <div className="auth-page">
      <h1>JARVIS HQ</h1>
      <p>Access denied.</p>
      <p>
        Provide a valid <code>?token=</code> to enter.
      </p>
    </div>
  );
}
