import { PairingStore, formatCode } from '@producible/cereworker-core';

export async function runApprove(code: string): Promise<void> {
  const store = new PairingStore();
  try {
    store.expireStale();
    const result = store.approveCode(code);
    if (result.ok) {
      const name = result.senderName ?? result.senderId;
      console.log(`Approved: ${name} on ${result.channelId}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  } finally {
    store.close();
  }
}

export async function runPairingList(): Promise<void> {
  const store = new PairingStore();
  try {
    store.expireStale();
    const pending = store.listPending();
    if (pending.length === 0) {
      console.log('No pending pairing requests.');
    } else {
      console.log(`Pending pairing requests (${pending.length}):\n`);
      for (const req of pending) {
        const age = Math.round((Date.now() - req.createdAt) / 60000);
        const ttl = Math.round((req.expiresAt - Date.now()) / 60000);
        const name = req.senderName ?? req.senderId;
        console.log(`  ${formatCode(req.code)}  ${req.channelId}  ${name}  ${age}m ago  expires in ${ttl}m`);
      }
      console.log(`\nApprove with: cereworker approve <CODE>`);
    }
  } finally {
    store.close();
  }
}
