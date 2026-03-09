import { upsertFile } from '../github/client.js';

export interface FileToWrite {
  path: string;       // relative to repo root, e.g. "src/tools/stripe.ts"
  content: string;
}

export interface SelfModifyPlan {
  toolId: string;
  description: string;
  files: FileToWrite[];
  npmPackage?: string;   // e.g. "stripe" — added to package.json dependencies
  envVarName?: string;   // e.g. "STRIPE_API_KEY"
}

/**
 * Push new tool files to GitHub. Railway auto-deploys on push.
 */
export async function executeSelfModify(plan: SelfModifyPlan): Promise<{ success: boolean; message: string }> {
  try {
    for (const file of plan.files) {
      await upsertFile(
        'jarvis',
        file.path,
        file.content,
        `feat: auto-install ${plan.toolId} tool`
      );
    }

    if (plan.npmPackage) {
      await addNpmDependency(plan.npmPackage);
    }

    const envNote = plan.envVarName
      ? ` Add \`${plan.envVarName}\` to Railway env vars to activate it.`
      : '';

    return {
      success: true,
      message: `Pushed ${plan.files.length} file(s) to GitHub. Railway is rebuilding now (~2 min).${envNote} I'll be ready after the deploy.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Self-modify failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Read package.json from GitHub, add the npm package to dependencies, push back.
 */
async function addNpmDependency(packageName: string): Promise<void> {
  const { Octokit } = await import('octokit');
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const owner = process.env.GITHUB_OWNER!;

  const { data } = await octokit.rest.repos.getContent({ owner, repo: 'jarvis', path: 'package.json' });
  if (Array.isArray(data) || data.type !== 'file') throw new Error('package.json not found');

  const raw = Buffer.from(data.content, 'base64').toString('utf-8');
  const pkg = JSON.parse(raw);
  pkg.dependencies[packageName] = `latest`;

  await upsertFile(
    'jarvis',
    'package.json',
    JSON.stringify(pkg, null, 2) + '\n',
    `feat: add ${packageName} dependency for auto-install`
  );
}

/**
 * Pre-defined plans for tools Jarvis knows how to auto-install.
 */
export const INSTALL_PLANS: Record<string, SelfModifyPlan> = {
  stripe: {
    toolId: 'stripe',
    description: 'Stripe payments — check revenue, list charges, manage subscriptions',
    envVarName: 'STRIPE_SECRET_KEY',
    npmPackage: 'stripe',
    files: [
      {
        path: 'src/tools/stripe.ts',
        content: `import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function getRevenueSummary(): Promise<string> {
  const charges = await stripe.charges.list({ limit: 10 });
  const total = charges.data.reduce((sum, c) => sum + (c.amount_captured ?? 0), 0);
  return \`Last 10 charges: $\${(total / 100).toFixed(2)} total. \${charges.data.length} transactions.\`;
}
`,
      },
    ],
  },
  twilio: {
    toolId: 'twilio',
    description: 'Twilio — send SMS messages',
    envVarName: 'TWILIO_AUTH_TOKEN',
    npmPackage: 'twilio',
    files: [
      {
        path: 'src/tools/twilio.ts',
        content: `import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export async function sendSms(to: string, body: string): Promise<string> {
  const msg = await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER!, to });
  return \`SMS sent: \${msg.sid}\`;
}
`,
      },
    ],
  },
};
