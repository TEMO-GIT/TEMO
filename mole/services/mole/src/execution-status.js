// Explicit public allowlist: journals contain signed transactions and private capsule openings.
export function executionStatus(state, { status, walletAddress, lastTickAt = null, lastSuccessfulTickAt = null, stopping = false,
  mode = 'phala-execution-development', transactionsEnabled = true }) {
  const queue = { awaitingInclusion:0,awaitingFinality:0,confirmed:0,reverted:0 };
  for(const entry of Object.values(state.actions)) {
    if(entry.status==='confirmed')queue.confirmed++;
    else if(entry.status==='reverted')queue.reverted++;
    else if(['mined','mined_reverted'].includes(entry.status))queue.awaitingFinality++;
    else queue.awaitingInclusion++;
  }
  const halted=Boolean(state.halted);
  return {mode,status:halted?'halted':status,walletAddress,
    productionReady:false,codeLocked:false,transactionsEnabled:transactionsEnabled&&!halted&&!stopping,stopping,
    lastTickAt,lastSuccessfulTickAt,queue,tradeCheckpoint:state.dataset?.block?.number??null,
    capsuleEncryption:'tlock-quicknet',capsuleCodecReady:true,seasonKeeperEnabled:true,
    capsuleCheckpoint:state.capsules?.block?.number??null,
    invalidCapsules:Object.keys(state.seasons?.invalid??{}).length,
    capsuleRetries:Object.keys(state.seasons?.retryAfter??{}).length,
    failedSeasonActions:Object.keys(state.seasons?.failed??{}).length};
}
