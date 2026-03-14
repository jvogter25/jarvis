const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

export async function getRailwayLogs(lines = 50): Promise<string> {
  const token = process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;

  if (!token || !serviceId) {
    return 'get_logs failed: RAILWAY_API_TOKEN and RAILWAY_SERVICE_ID must be set in env vars. See .env.example for setup instructions.';
  }

  const clampedLines = Math.min(Math.max(lines, 1), 200);

  try {
    // Step 1: Get the latest deployment for the service
    const deploymentQuery = `
      query GetDeployments($serviceId: String!) {
        deployments(first: 1, input: { serviceId: $serviceId }) {
          edges {
            node {
              id
              status
              createdAt
            }
          }
        }
      }
    `;

    const deployRes = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: deploymentQuery, variables: { serviceId } }),
    });

    if (!deployRes.ok) {
      return `get_logs failed: Railway API returned ${deployRes.status}`;
    }

    const deployData = await deployRes.json() as {
      data?: { deployments?: { edges?: Array<{ node: { id: string; status: string; createdAt: string } }> } };
      errors?: Array<{ message: string }>;
    };

    if (deployData.errors?.length) {
      return `get_logs failed: ${deployData.errors.map(e => e.message).join(', ')}`;
    }

    const deploymentEdges = deployData.data?.deployments?.edges;
    if (!deploymentEdges || deploymentEdges.length === 0) {
      return 'get_logs: No deployments found for this service.';
    }

    const deployment = deploymentEdges[0].node;

    // Step 2: Fetch logs for that deployment
    const logsQuery = `
      query GetDeploymentLogs($deploymentId: String!, $limit: Int!) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          message
          severity
        }
      }
    `;

    const logsRes = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: logsQuery, variables: { deploymentId: deployment.id, limit: clampedLines } }),
    });

    if (!logsRes.ok) {
      return `get_logs failed: Railway API returned ${logsRes.status} fetching logs`;
    }

    const logsData = await logsRes.json() as {
      data?: { deploymentLogs?: Array<{ timestamp: string; message: string; severity: string }> };
      errors?: Array<{ message: string }>;
    };

    if (logsData.errors?.length) {
      return `get_logs failed: ${logsData.errors.map(e => e.message).join(', ')}`;
    }

    const logEntries = logsData.data?.deploymentLogs;
    if (!logEntries || logEntries.length === 0) {
      return `get_logs: No log entries found. Deployment ${deployment.id} status: ${deployment.status}`;
    }

    const formatted = logEntries.map(entry => {
      const ts = new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const level = entry.severity !== 'INFO' ? `[${entry.severity}] ` : '';
      return `${ts} ${level}${entry.message}`;
    }).join('\n');

    return `Railway logs — deployment ${deployment.id} (${deployment.status}), last ${logEntries.length} lines:\n\n${formatted}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `get_logs failed: ${msg}`;
  }
}
