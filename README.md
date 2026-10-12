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

## Disclosures

- No owner, admin, pause, mint, blacklist, transfer restriction or upgrade path in any contract. All addresses are
  immutable constructor arguments; the only privileged address is the mole (commit/judge weights, bind the hook once,
  publish season data). The mole cannot change fees, move liquidity or stop trading.
- Platform fee: 3,000 pips (0.30%) of the gross ETH leg on every buy and sell, including the launch buy, accrued as
  ERC-6909 ETH claims to `FeeTill` with the immutable recipient `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`;
  anyone can call `collect()`, payment goes only to that recipient.
- Project fee: 9,000 dev + 1,000 mole + 2,000..10,000 capsule pool, i.e. 12,000..20,000 pips set per trade by the
  model (16,000 at the neutral score). The model call is gas-capped; on failure the neutral score applies.
- Liquidity: the launch initializer puts the whole supply into a single-sided position owned by `0x000000000000000000000000000000000000dEaD`
  through the canonical PositionManager, performs the launch buy with part of the transaction value, seeds a second
  full-range position with the bought tokens and the remaining ETH, also owned by the dead address, and burns the rest.
  No contract holds a withdrawal path for either position.
- External calls: Chainlink ETH/USD (season resolution only), Automata DCAP verifier (one-shot mole proof), drand
  quicknet verified through the EIP-2537 precompiles (weight judging). None of them is on the swap path except the
  model `staticcall`, which is bounded and non-reverting.
- Swaps with empty hook data are standard exact-input or exact-output swaps. Hook data of 96+ bytes is optional and
  only records a capsule for the trader.

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
