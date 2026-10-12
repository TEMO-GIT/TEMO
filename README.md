# TEMO contracts

A token on Ethereum whose Uniswap v4 pool fee is set trade by trade by a small neural network that lives on-chain,
and a seasonal prediction game paid from that fee. The only privileged address is the mole: a wallet born inside a
sealed TDX enclave. No contract has an owner.

## Contracts

| Contract | Role |
|---|---|
| `TemoToken` | ERC-20, fixed supply minted once, keeps a balance history per account (`balanceAt`) |
| `TemoHook` | the pool hook: takes the fee in ETH, asks the model, writes trade records, pushes season metrics |
| `TemoModel` | 9-16-1 network in Q8.8; weights in a data contract; the on-chain judge accepts new weights only when they score better on drand-sampled records |
| `Burrow` | seasons, capsules (commit + ciphertext event), nine questions on a 1-2-5 grid, reveal, claim, roll-over |
| `MoleProof` | one-shot proof that the mole's wallet was attested by Intel TDX (Automata DCAP verifier) with pinned measurements |
| `Seeder` | launch initializer: opens the pool, locks the supply as a 0xdEaD position, dev buy, full-range position, burns the rest |
| `FeeTill` | holds ERC-6909 ETH claims for one immutable recipient; anyone can trigger the payout |

Fee per swap, in pips: platform 3,000 + dev 9,000 + mole 1,000 (while the mole holds under 0.1 ETH, otherwise dev)
+ capsule pool 2,000 + 8,000 × score / 10,000. Bounds are constants in the hook.

## Build and test

```
forge build
forge test --no-match-contract LaunchTest
ETH_RPC=<mainnet rpc> forge test --match-contract LaunchTest   # full launch and a whole season on a mainnet fork
```

The drand tests verify real quicknet beacons through the EIP-2537 precompiles.

## Layout

- `src/` contracts, `src/libraries/` fee math, 1-2-5 grid, record packing, drand verification
- `test/` unit tests and the mainnet-fork rehearsal
