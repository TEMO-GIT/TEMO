# TEMO

A token on Ethereum whose swap fee is decided trade by trade by a small neural network that lives on-chain.
The network is trained by a mole: a wallet born inside a sealed Intel TDX enclave that nobody can open, not even
the team. Every eight days the pool runs a season, and anyone who buried a capsule with nine predictions gets paid
from the fee for the answers they got right.

Nothing here has an owner. Every address is an immutable constructor argument, and the only privileged one is the
mole, whose powers are listed below and end there.

## Contracts

| Contract | What it does |
|---|---|
| `TemoToken` | ERC-20, one billion tokens minted once, burnable. Keeps a balance history per account so a season can read anyone's balance at any past moment. |
| `TemoHook` | The one permanent hook of the TEMO/ETH pool. Takes the fee in ETH, asks the model for a score, writes one packed record per trade, pushes season metrics to the burrow. |
| `TemoModel` | A 9-16-1 network in Q8.8 fixed point, weights in a data contract. Judges every proposed weight update on-chain against drand-sampled trades. Also holds the mole's one-shot TDX proof, verified through the Automata DCAP contracts with the enclave measurements pinned. |
| `Burrow` | Seasons, capsules, verdicts and payouts. |
| `Seeder` | Runs once, inside the launch transaction: opens the pool, locks the supply, performs the launch buy, seeds a second position, burns what is left. |

## The fee

Every swap pays a fee on its ETH leg. The fee is collected by the hook, never by the token, so it does not touch
transfers and applies to every trade through the pool.

| Share | Pips | Goes to |
|---|---|---|
| Platform | 3,000 (0.30%) | ETH claims held by the hook for the Programmable recipient `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`; anyone can call `collect(recipient)` |
| Dev | 9,000 (0.90%) | ETH claims held by the hook for the dev recipient, paid out the same way |
| Mole | 1,000 (0.10%) | The mole's wallet, for gas, while it holds under 0.1 ETH; otherwise the dev |
| Capsule pool | 2,000 to 10,000 (0.20% to 1.00%) | The burrow, as the prize pool of the running season |

The capsule share is the only moving part: `2,000 + 8,000 × score / 10,000`, where the score is the model's
estimate of how fast this trader will dump. A patient holder pays about 1.5% in total, a predicted flipper up to 2.3%.
The bounds are constants in the hook. The model is called with a gas-capped `staticcall`; if it fails for any
reason the neutral score applies and the swap goes through.

## How the model learns

Each trade is written to the hook as one 256-bit record: direction, size relative to liquidity, minutes since the
wallet's last trade, priority fee, trades in the last 24 hours, holding time, capsule age, hourly volume, whether the
wallet is new. These are the nine inputs.

The label is what the trader did next. The hook keeps one open position per wallet: buys merge into it, sells take
from it. A sell within ten minutes of the first buy scores 100, within an hour 80, within six hours 50, within
twenty hours 25, later 0. The position's final label is the sum of its sells' scores weighted by the fraction of the
position they sold, and whatever is still held twenty hours after the last buy counts as held. Anyone can close an
expired position with `settle`.

The mole trains off-chain on these records and proposes new weights. The contract decides whether to adopt them:

1. `commit`: the mole names the new weights. The record count is frozen and a drand quicknet round one minute in
   the future is fixed. Nothing about that round's randomness is known yet.
2. `judge`: anyone submits the beacon of that round. The contract verifies the BLS signature through the EIP-2537
   precompiles, samples 48 finished records with that randomness, scores both the current and the proposed weights
   on them, and adopts the proposal only if its squared error is at least 3% lower.

Weights cannot be set any other way. Commits are at most one per twenty hours, a commit that is not judged within a
day expires, and the previous weights stay active throughout.

## Seasons and capsules

A cycle is eight days: a 24-hour prediction window followed by a seven-day season. The capsule share of the fee
collected during the cycle is the season's prize pool.

During the window any address may bury one capsule: the hash of nine answers plus a salt, with the encrypted answers
published in an event. A capsule can also ride along with a buy, in the swap's hook data. Tokens are never locked.
A capsule's weight is the smaller of the owner's balance at the start of the season and at its end, read from the
token's balance history.

When the season ends, anyone calls `resolve`. The contract settles the nine answers from what the hook reported
during the season, each on a 1-2-5 grid:

| # | Question |
|---|---|
| 1 | Market cap at the close |
| 2 | Highest market cap of the season |
| 3 | Lowest market cap of the season |
| 4 | Change from the opening cap to the close |
| 5 | Volume in USD |
| 6 | Number of new wallets |
| 7 | Which came first, doubling or halving, or neither |
| 8 | The busiest day |
| 9 | The size of the prize pool itself |

The pool splits into nine equal shares, one per question. Owners reveal their answers within 24 hours after the
close, by themselves or through anyone willing to pay the gas; the reveal is checked against the hash and the
payout always goes to the owner. Each share is divided pro rata by weight among the capsules that hit the exact
bucket. Claims stay open for 30 days; a share nobody won, or nobody claimed, rolls forward into the running season.

Market cap uses the pool's last trade price, the circulating supply (total minus the dead address) and the Chainlink
ETH/USD feed; a stale feed is recorded as such in the resolution instead of blocking it. Only the canonical
TEMO/ETH pool is observed; trades elsewhere do not count toward seasons, labels or fees.

## The mole

The mole is a wallet whose key was generated inside a TDX enclave running a fixed container image. It can:

- prove itself once through `TemoModel.proveMole`;
- commit new weights (the contract judges them);
- publish every capsule's answers after a season, for the leaderboard.

It cannot change any fee, move liquidity, pause anything or touch anyone's tokens. `TemoModel.proveMole` accepts
one DCAP quote whose report data is the mole's address (left-padded to 32 bytes, then 32 zero bytes) and whose measurements equal the
hashes pinned at deployment. The proof is permanent and anyone can read it.

## Launch

The launch is one transaction through the Programmable launch router. It deploys all five contracts, with the
mole's address, the enclave measurements and the v0 weights as constructor arguments, then runs their initializers
in order: `TemoModel.setHook` binds the hook, `Seeder.ignite` initializes the pool,
puts the entire supply into a single-sided position owned by `0x000000000000000000000000000000000000dEaD` through
the canonical PositionManager, buys with part of the transaction value, seeds a second full-range position with the
bought tokens and the remaining ETH, also owned by the dead address, and burns whatever is left over. No contract
holds a withdrawal path for either position. Finally `Burrow.bindHook` binds the hook, so the burrow counts every
trade after the launch buy. Both binders accept only their deployer (the graph factory), only once, and only a hook
that names them.

For the first twenty swaps after the launch buy, a single buy may take at most 2% of the supply (20,000,000 tokens);
a larger buy reverts. Sells are never capped, and from the twenty-first swap on there is no limit. Both numbers are
constants in the hook.

## Disclosures

- No owner, admin, pause, mint, blacklist, transfer restriction or upgrade path in any contract.
- Platform fee: 3,000 pips of the gross ETH leg on every buy and sell, including the launch buy, accrued as ERC-6909
  ETH claims owned by the hook and booked per recipient; anyone can call `collect(recipient)`, payment goes only to
  the two immutable recipients.
- Project fee: 12,000 to 20,000 pips, set per trade by the model as described above; 16,000 at the neutral score.
- External calls: Chainlink ETH/USD (season resolution only), the Automata DCAP verifier (the one-shot mole proof),
  drand quicknet through the EIP-2537 precompiles (weight judging). None of them is on the swap path except the
  bounded, non-reverting model call.
- Launch guard: the first twenty swaps after the launch buy may not buy more than 2% of the supply each; nothing
  else limits buys or sells at any time.
- Swaps with empty hook data are standard exact-input or exact-output swaps. Hook data of 96 bytes or more is
  optional and only buries a capsule for the trader.

## Build and test

```
forge build
forge test --no-match-contract LaunchTest
ETH_RPC=<mainnet rpc> forge test --match-contract LaunchTest   # launch and a whole season on a mainnet fork
```

The drand tests verify real quicknet beacons through the precompiles. The fork suite launches the pool through the
seeder, checks the fee split on buys and sells, the hold labels, the mole's gas cap and a complete season from
capsule to claim.

## Layout

- `src/` the five contracts and `src/interfaces/ITemo.sol`
- `src/libraries/` fee math, the 1-2-5 grid, record packing, drand verification
- `test/` unit tests and the mainnet-fork rehearsal
