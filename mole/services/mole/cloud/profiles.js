// Key identity parameters are release inputs, not mutable environment overrides.
const profiles = {
  development: Object.freeze({ name: 'temo-mole-dev', mode: 'phala-development',
    directory: 'cloud', entrypoint: 'main.js', kms: 'phala', kmsGovernance: 'phala-cloud',
    keyPath: 'temo/cloud-development/ethereum-wallet/v1' }),
  production: Object.freeze({ name: 'temo-mole-prod', mode: 'phala-production-standby',
    directory: 'production', entrypoint: 'production-main.js', kms: 'ethereum', kmsGovernance: 'ethereum-onchain',
    keyPath: 'temo/production/ethereum-wallet/v1' }),
};
export function cloudProfile(name = 'development') {
  if (!Object.hasOwn(profiles, name)) throw new Error('Unknown cloud target');
  return profiles[name];
}

// Reserved identities: switching the entrypoint must never create a replacement wallet.
const executionIdentities = {
  development: { appId: '4533cd8a66fa11564e999708b6c2e3553f876d34', walletAddress: '0xC5eF8776C31c9386bfC580F7B05EC7D2F44cE1A9' },
  production: { appId: '8c8611b298e5d97b18fd479d03ae4696f3e951ce', walletAddress: '0x43a02861eE0d4c6D1881c0a24937b6Bf95dA9917' },
};
export function executionProfile(target) {
  if (!Object.hasOwn(executionIdentities, target)) throw new Error('Explicit execution target required');
  const profile = cloudProfile(target);
  return Object.freeze({ ...profile, ...executionIdentities[target], mode: `phala-execution-${target}` });
}
