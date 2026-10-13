import { PROOF_PROTOCOL, cleanHex, fromHex, publicReportData } from '../../../shared/proof-protocol.js';

export async function createPublicProof(client, walletAddress, nonce) {
  nonce = cleanHex(nonce, 32);
  const info = await client.info();
  const identity = { nonce, walletAddress, appId: cleanHex(info.app_id, 20), composeHash: cleanHex(info.compose_hash, 32) };
  const quoted = await client.getQuote(fromHex(await publicReportData(identity)));
  return { schemaVersion: 1, protocol: PROOF_PROTOCOL, ...identity, quote: quoted.quote,
    eventLog: quoted.event_log, appCompose: info.tcb_info?.app_compose ?? null };
}

// Public, read-only, one in-flight quote. No message signing or transaction interface.
export function createPublicProofHandler({ client, walletAddress, isReady = () => true }) {
  let busy = false;
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/public-attestation') return null;
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
    const reply = (body, status = 200) => Response.json(body, { status, headers });
    if (request.method !== 'GET') return reply({ error: 'GET required' }, 405);
    let nonce;
    try { nonce = cleanHex(url.searchParams.get('nonce'), 32); }
    catch { return reply({ error: 'A 32-byte hexadecimal nonce is required' }, 400); }
    if (!isReady()) return reply({ error: 'Service not ready' }, 503);
    if (busy) return reply({ error: 'Quote generation busy; retry shortly' }, 429);
    busy = true;
    try {
      const proof = await createPublicProof(client, walletAddress, nonce);
      return isReady() ? reply(proof) : reply({ error: 'Service not ready' }, 503);
    } catch { return reply({ error: 'Quote generation unavailable' }, 503); }
    finally { busy = false; }
  };
}
