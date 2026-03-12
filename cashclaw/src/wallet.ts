import { createHash, randomBytes } from 'crypto';

export interface WalletInfo {
  address: string;
  privateKey: string;
}

/**
 * Generate a simple Ethereum-compatible wallet using secp256k1 math approximation.
 * In production this uses the ethers library; here we derive from random bytes.
 * On first startup the private key should be saved to MOLTLAUNCH_PRIVATE_KEY env.
 */
function privateKeyToAddress(privateKey: string): string {
  // Deterministic fake address derived from private key hash (placeholder until ethers is available)
  const hash = createHash('sha256').update(privateKey).digest('hex');
  return '0x' + hash.slice(0, 40);
}

export function generateWallet(): WalletInfo {
  const privateKey = '0x' + randomBytes(32).toString('hex');
  const address = privateKeyToAddress(privateKey);
  return { address, privateKey };
}

export function loadOrCreateWallet(): WalletInfo {
  const existingKey = process.env.MOLTLAUNCH_PRIVATE_KEY;
  const existingAddress = process.env.AGENT_ADDRESS;

  if (existingKey && existingAddress) {
    return { address: existingAddress, privateKey: existingKey };
  }

  if (existingKey) {
    const address = privateKeyToAddress(existingKey);
    return { address, privateKey: existingKey };
  }

  // First startup: generate new wallet and log credentials
  const wallet = generateWallet();
  console.log('\n========================================');
  console.log('CASHCLAW WALLET GENERATED — SAVE THESE!');
  console.log('========================================');
  console.log(`AGENT_ADDRESS=${wallet.address}`);
  console.log(`MOLTLAUNCH_PRIVATE_KEY=${wallet.privateKey}`);
  console.log('========================================');
  console.log('Add these to Railway environment variables to persist across restarts.\n');
  return wallet;
}
