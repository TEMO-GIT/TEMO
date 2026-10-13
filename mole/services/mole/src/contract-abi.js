import { parseAbi } from 'viem';

// A scoped source-derived ABI, not a deployment manifest or a frozen handoff from the developer.
export const hookAbi = parseAbi([
  'event Trade(uint256 indexed index,address indexed origin,uint256 record,uint16 score)',
  'event PositionClosed(address indexed origin,uint32 indexed id,uint8 label)',
  'function recordCount() view returns (uint256)',
  'function records(uint256) view returns (uint256)',
  'function positions(uint32) view returns (uint256)',
  'function model() view returns (address)',
  'function burrow() view returns (address)',
  'function token() view returns (address)',
  'function launchedAt() view returns (uint40)',
  'function profiles(address) view returns (uint40 firstSeen,uint40 lastTrade,uint16 trades24h,uint40 windowStart,uint32 posId,uint40 openTs,uint40 lastBuyTs,uint96 openAmount,uint96 soldAmount,uint40 capsuleTs,uint24 labelAcc)',
  'function settleMany(address[] origins)',
]);
export const tradeEvent = hookAbi.find(x => x.name === 'Trade');

export const modelAbi = parseAbi([
  'function deployer() view returns (address)',
  'function hook() view returns (address)',
  'function mole() view returns (address)',
  'function weights() view returns (address)',
  'function version() view returns (uint32)',
  'function lastCommitAt() view returns (uint40)',
  'function pending() view returns (address weights,uint40 committedAt,uint64 round,uint256 recordsFrozen)',
  'function commit(address newWeights)',
  'function judge(bytes signature)',
  'function scoreWith(address weights,uint256 record) view returns (uint16)',
  'event WeightsCommitted(address indexed weights,uint64 round,uint256 recordsFrozen)',
  'event WeightsJudged(address indexed weights,bool adopted,uint256 sseOld,uint256 sseNew,uint256 samples)',
  'event WeightsAdopted(address indexed weights,uint32 version)',
]);

export const burrowAbi = parseAbi([
  'event Buried(uint32 indexed season,address indexed owner,bytes32 commit,bytes ciphertext)',
  'function resolve(uint32 season)',
  'function reveal(uint32 season,address owner,uint8[9] answers,bytes32 salt)',
  'function publish(uint32 season,address[] owners,uint8[9][] answers)',
  'function rollover(uint32 season)',
  'function cycleAt(uint256 timestamp) view returns (uint32)',
  'function seasonStart(uint32 season) view returns (uint256)',
  'function seasonEnd(uint32 season) view returns (uint256)',
  'function seasonInfo(uint32 season) view returns (bool started,bool resolved,uint160 sqrtStart,uint160 sqrtLast,uint160 sqrtMax,uint160 sqrtMin,uint8 maxDay,uint8 crossed,uint32 newWallets,uint64 volumeMicroEth,uint256 pool,uint256 paid)',
  'function winning(uint32 season) view returns (uint32[9])',
  'function capsuleCount(uint32 season) view returns (uint256)',
  'function capsuleOf(uint32 season,address owner) view returns (bytes32 commit,bool revealed,uint16 hits,uint256 weight,bool claimed)',
  'function hook() view returns (address)',
  'function mole() view returns (address)',
  'function token() view returns (address)',
  'function deployer() view returns (address)',
  'function launchedAt() view returns (uint40)',
]);
export const buriedEvent = burrowAbi.find(x => x.name === 'Buried');
export const tokenSnapshotAbi = parseAbi(['function balanceAt(address owner,uint48 timestamp) view returns (uint256)']);
