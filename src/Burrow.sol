// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: <fill in before deploy>
// X:       <fill in before deploy>

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {ITemoToken, ITemoHook, IPriceFeed} from "./interfaces/ITemo.sol";
import {Grid125} from "./libraries/Grid125.sol";

/// @title Burrow
/// @notice Seasons, capsules, verdicts, payouts. No owner. The mole may only bind the hook (once) and publish
///         answers; everything else is open to anyone.
///  - a capsule is a hash of 9 answers + salt; the ciphertext goes to an event only
///  - tokens are never locked: capsule weight = min(balance at season start, balance at season end)
///  - the season pool is the capsule share of the hook fee collected during the cycle
///  - nine questions, nine equal shares, exact bucket only, pro-rata by weight, unanswered shares roll forward
contract Burrow {
    uint256 public constant WINDOW = 24 hours;
    uint256 public constant SEASON = 7 days;
    uint256 public constant CYCLE = WINDOW + SEASON;
    uint256 public constant SELF_REVEAL = 24 hours;
    uint256 public constant CLAIM_WINDOW = 30 days;
    uint256 public constant QUESTIONS = 9;
    uint256 public constant PRICE_MAX_AGE = 1 hours;
    uint256 private constant Q96 = 2 ** 96;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable mole;
    ITemoToken public immutable token;
    IPriceFeed public immutable priceFeed; // ETH/USD, 8 decimals
    address public hook;
    uint40 public launchedAt; // start of window 1 = pool initialization

    struct SeasonData {
        uint160 sqrtStart;
        uint160 sqrtLast;
        uint160 sqrtMax;
        uint160 sqrtMin;
        uint8 maxDay;
        uint8 crossed; // 0 none, 1 doubled first, 2 halved first
        uint32 newWallets;
        uint64 volumeMicroEth;
        bool started;
        bool resolved;
        uint256 pool; // wei, fees received during the cycle + roll-overs
        uint256 paid;
        uint32[QUESTIONS] winning;
        uint256[QUESTIONS] winnersWeight;
        uint256 revealedCount;
        uint64 priceUsd8; // ETH/USD used at resolve
        bool priceStale;
    }

    struct Capsule {
        bytes32 commit;
        uint16 hits; // bitmask of guessed questions, set at reveal
        uint256 weight;
        bool revealed;
        bool claimed;
    }

    mapping(uint32 season => SeasonData) internal _seasons;
    mapping(uint32 season => mapping(address owner => Capsule)) internal _capsules;
    mapping(uint32 season => uint256) public capsuleCount;

    error NotMole();
    error NotHook();
    error HookAlreadyBound();
    error WrongHook();
    error NotLaunched();
    error WindowClosed();
    error AlreadyBuried();
    error SeasonNotOver();
    error AlreadyResolved();
    error NotResolved();
    error RevealClosed();
    error BadReveal();
    error ClaimNotOpen();
    error NothingToClaim();
    error ClaimStillOpen();
    error ZeroAddress();

    event HookBound(address hook, uint40 launchedAt);
    event Buried(uint32 indexed season, address indexed owner, bytes32 commit, bytes ciphertext);
    event SeasonStarted(uint32 indexed season, uint160 sqrtStart);
    event Resolved(uint32 indexed season, uint32[QUESTIONS] winning, uint256 pool, uint64 priceUsd8, bool priceStale);
    event Revealed(uint32 indexed season, address indexed owner, uint8[QUESTIONS] answers, uint16 hits, uint256 weight);
    event Claimed(uint32 indexed season, address indexed owner, uint256 amount);
    event RolledOver(uint32 indexed fromSeason, uint32 indexed toSeason, uint256 amount);
    event Published(uint32 indexed season, address[] owners, uint8[QUESTIONS][] answers);
    event PoolFunded(uint32 indexed season, uint256 amount);

    constructor(address mole_, ITemoToken token_, IPriceFeed priceFeed_) {
        if (mole_ == address(0) || address(token_) == address(0) || address(priceFeed_) == address(0)) revert ZeroAddress();
        mole = mole_;
        token = token_;
        priceFeed = priceFeed_;
    }

    // ================= wiring =================

    /// @notice Bind the pool hook: only the mole, once, only when the hook exists and points back here.
    function bindHook(ITemoHook hook_) external {
        if (msg.sender != mole) revert NotMole();
        if (hook != address(0)) revert HookAlreadyBound();
        if (address(hook_).code.length == 0 || hook_.burrow() != address(this)) revert WrongHook();
        uint40 t = hook_.launchedAt();
        if (t == 0) revert NotLaunched();
        hook = address(hook_);
        launchedAt = t;
        emit HookBound(address(hook_), t);
    }

    /// @notice Capsule-share fees arrive here as ETH, credited to the cycle in progress.
    receive() external payable {
        uint32 s = launchedAt == 0 ? 1 : cycleAt(block.timestamp);
        _seasons[s].pool += msg.value;
        emit PoolFunded(s, msg.value);
    }

    // ================= clock =================

    /// @notice Cycle (= season number) that contains `timestamp`: window n then season n.
    function cycleAt(uint256 timestamp) public view returns (uint32) {
        if (launchedAt == 0 || timestamp < launchedAt) return 1;
        return uint32((timestamp - launchedAt) / CYCLE + 1);
    }

    function seasonStart(uint32 season) public view returns (uint256) {
        return uint256(launchedAt) + WINDOW + (uint256(season) - 1) * CYCLE;
    }

    function seasonEnd(uint32 season) public view returns (uint256) {
        return seasonStart(season) + SEASON;
    }

    function windowOpen(uint32 season) public view returns (bool) {
        uint256 start = seasonStart(season);
        return launchedAt != 0 && block.timestamp >= start - WINDOW && block.timestamp < start;
    }

    // ================= capsules =================

    function bury(bytes32 commit, bytes calldata ciphertext) external {
        _bury(msg.sender, commit, ciphertext);
    }

    /// @notice Buy and leave a capsule in one transaction: the hook passes the swap's hookData here.
    function buryFor(address owner, bytes32 commit, bytes calldata ciphertext) external {
        if (msg.sender != hook) revert NotHook();
        _bury(owner, commit, ciphertext);
    }

    function _bury(address owner, bytes32 commit, bytes calldata ciphertext) private {
        if (launchedAt == 0) revert NotLaunched();
        uint32 s = cycleAt(block.timestamp);
        if (!windowOpen(s)) revert WindowClosed();
        Capsule storage c = _capsules[s][owner];
        if (c.commit != bytes32(0)) revert AlreadyBuried();
        c.commit = commit;
        ++capsuleCount[s];
        ITemoHook(hook).noteCapsule(owner, uint40(block.timestamp));
        emit Buried(s, owner, commit, ciphertext);
    }

    // ================= metrics (from the hook) =================

    function onTrade(uint160 sqrtBefore, uint160 sqrtAfter, uint256 ethVolume, bool newWallet) external {
        if (msg.sender != hook) {
            if (hook != address(0)) revert NotHook();
            return; // before binding (the launch transaction itself): nothing to record yet
        }
        uint32 s = cycleAt(block.timestamp);
        uint256 start = seasonStart(s);
        if (block.timestamp < start) return; // prediction window: not part of the season
        SeasonData storage d = _seasons[s];
        if (!d.started) {
            d.started = true;
            d.sqrtStart = sqrtBefore;
            d.sqrtMax = sqrtBefore;
            d.sqrtMin = sqrtBefore;
            emit SeasonStarted(s, sqrtBefore);
        }
        d.sqrtLast = sqrtAfter;
        // price = token per ETH; a LOWER sqrt means a HIGHER token value, i.e. a higher cap
        if (sqrtAfter < d.sqrtMin) {
            d.sqrtMin = sqrtAfter;
            d.maxDay = uint8((block.timestamp - start) / 1 days);
            if (d.crossed == 0 && uint256(sqrtAfter) * 1_414_214 <= uint256(d.sqrtStart) * 1_000_000) d.crossed = 1;
        }
        if (sqrtAfter > d.sqrtMax) {
            d.sqrtMax = sqrtAfter;
            if (d.crossed == 0 && uint256(sqrtAfter) * 1_000_000 >= uint256(d.sqrtStart) * 1_414_214) d.crossed = 2;
        }
        uint256 micro = ethVolume / 1e12;
        d.volumeMicroEth = uint64(uint256(d.volumeMicroEth) + micro > type(uint64).max ? type(uint64).max : uint256(d.volumeMicroEth) + micro);
        if (newWallet) ++d.newWallets;
    }

    // ================= resolve =================

    /// @notice After the season's end: convert, bucket, fix the nine winning indexes. Anyone.
    function resolve(uint32 season) external {
        SeasonData storage d = _seasons[season];
        if (block.timestamp < seasonEnd(season)) revert SeasonNotOver();
        if (d.resolved) revert AlreadyResolved();
        d.resolved = true;

        (uint64 price, bool stale) = _ethUsd();
        d.priceUsd8 = price;
        d.priceStale = stale;

        uint256 circ = token.totalSupply() - token.balanceOf(DEAD);
        uint256 capClose = _capUsd(d.sqrtLast, circ, price);
        uint256 capMax = _capUsd(d.sqrtMin, circ, price);
        uint256 capMin = _capUsd(d.sqrtMax, circ, price);
        uint256 capStart = _capUsd(d.sqrtStart, circ, price);

        d.winning[0] = Grid125.bucket(capClose);
        d.winning[1] = Grid125.bucket(capMax);
        d.winning[2] = Grid125.bucket(capMin);
        d.winning[3] = _changeBucket(capStart, capClose);
        d.winning[4] = Grid125.bucket(uint256(d.volumeMicroEth) * price / 1e14); // µETH * usd8 / 1e14 = USD
        d.winning[5] = Grid125.bucket(d.newWallets);
        d.winning[6] = d.crossed;
        d.winning[7] = d.maxDay;
        d.winning[8] = Grid125.bucket(d.pool);

        emit Resolved(season, d.winning, d.pool, price, stale);
    }

    /// @dev <= -50% | -50..0 | 0..+100 | +100..+300 | +300..+900 | > +900, as 0..5. No trades: 2 (unchanged).
    function _changeBucket(uint256 start, uint256 close) private pure returns (uint32) {
        if (start == 0) return 2;
        if (close * 2 <= start) return 0;
        if (close < start) return 1;
        if (close < start * 2) return 2;
        if (close < start * 4) return 3;
        if (close < start * 10) return 4;
        return 5;
    }

    /// @dev Cap in whole USD: circulating * (ETH per token) * ETH/USD. ETH per token = (2^96 / sqrtP)^2.
    function _capUsd(uint160 sqrtP, uint256 circ, uint64 price) private pure returns (uint256) {
        if (sqrtP == 0) return 0;
        uint256 capEth = FullMath.mulDiv(FullMath.mulDiv(circ, Q96, sqrtP), Q96, sqrtP); // wei-scaled (token 18 dec)
        return FullMath.mulDiv(capEth, price, 1e26); // / 1e18 (wei) / 1e8 (price decimals)
    }

    function _ethUsd() private view returns (uint64 price, bool stale) {
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        stale = answer <= 0 || block.timestamp - updatedAt > PRICE_MAX_AGE;
        price = answer <= 0 ? 0 : uint64(uint256(answer));
    }

    // ================= reveal & claim =================

    /// @notice Open a capsule: the mole for the winners, or the owner themself. Until SELF_REVEAL after the end.
    function reveal(uint32 season, address owner, uint8[QUESTIONS] calldata answers, bytes32 salt) external {
        SeasonData storage d = _seasons[season];
        if (!d.resolved) revert NotResolved();
        if (block.timestamp > seasonEnd(season) + SELF_REVEAL) revert RevealClosed();
        Capsule storage c = _capsules[season][owner];
        if (c.commit == bytes32(0) || c.revealed) revert BadReveal();
        if (keccak256(abi.encode(owner, season, answers, salt)) != c.commit) revert BadReveal();

        uint256 wStart = token.balanceAt(owner, uint48(seasonStart(season)));
        uint256 wEnd = token.balanceAt(owner, uint48(seasonEnd(season)));
        uint256 weight = wStart < wEnd ? wStart : wEnd;
        uint16 hits;
        for (uint256 q = 0; q < QUESTIONS; ++q) {
            if (answers[q] == d.winning[q]) {
                hits |= uint16(1 << q);
                d.winnersWeight[q] += weight;
            }
        }
        c.revealed = true;
        c.hits = hits;
        c.weight = weight;
        ++d.revealedCount;
        emit Revealed(season, owner, answers, hits, weight);
    }

    function prizeOf(uint32 season, address owner) public view returns (uint256 amount) {
        SeasonData storage d = _seasons[season];
        Capsule storage c = _capsules[season][owner];
        if (!c.revealed || c.weight == 0) return 0;
        uint256 shareQ = d.pool / QUESTIONS;
        for (uint256 q = 0; q < QUESTIONS; ++q) {
            if (c.hits & (1 << q) != 0 && d.winnersWeight[q] != 0) {
                amount += FullMath.mulDiv(shareQ, c.weight, d.winnersWeight[q]);
            }
        }
    }

    /// @notice ETH prize, after the self-reveal window closes.
    function claim(uint32 season) external {
        if (block.timestamp <= seasonEnd(season) + SELF_REVEAL) revert ClaimNotOpen();
        Capsule storage c = _capsules[season][msg.sender];
        if (c.claimed) revert NothingToClaim();
        uint256 amount = prizeOf(season, msg.sender);
        if (amount == 0) revert NothingToClaim();
        c.claimed = true;
        _seasons[season].paid += amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert NothingToClaim();
        emit Claimed(season, msg.sender, amount);
    }

    /// @notice CLAIM_WINDOW after the end: whatever was not won or not claimed rolls into the cycle in progress.
    function rollover(uint32 season) external {
        SeasonData storage d = _seasons[season];
        if (!d.resolved) revert NotResolved();
        if (block.timestamp <= seasonEnd(season) + SELF_REVEAL + CLAIM_WINDOW) revert ClaimStillOpen();
        uint256 owed;
        uint256 shareQ = d.pool / QUESTIONS;
        for (uint256 q = 0; q < QUESTIONS; ++q) {
            if (d.winnersWeight[q] != 0) owed += shareQ;
        }
        // owed = everything winners could ever claim; paid <= owed. Leftover = pool - paid - (owed - paid) = pool - owed,
        // plus the unclaimed part (owed - paid). After the window, unclaimed is forfeited: leftover = pool - paid.
        uint256 leftover = d.pool - d.paid;
        if (leftover == 0) return;
        d.pool = d.paid;
        uint32 to = cycleAt(block.timestamp);
        if (to <= season) to = season + 1;
        _seasons[to].pool += leftover;
        emit RolledOver(season, to, leftover);
    }

    /// @notice All answers of a season, for the leaderboard. Only the mole, event only.
    function publish(uint32 season, address[] calldata owners, uint8[QUESTIONS][] calldata answers) external {
        if (msg.sender != mole) revert NotMole();
        emit Published(season, owners, answers);
    }

    // ================= views =================

    function seasonInfo(uint32 season)
        external
        view
        returns (
            bool started,
            bool resolved,
            uint160 sqrtStart,
            uint160 sqrtLast,
            uint160 sqrtMax,
            uint160 sqrtMin,
            uint8 maxDay,
            uint8 crossed,
            uint32 newWallets,
            uint64 volumeMicroEth,
            uint256 pool,
            uint256 paid
        )
    {
        SeasonData storage d = _seasons[season];
        return (
            d.started,
            d.resolved,
            d.sqrtStart,
            d.sqrtLast,
            d.sqrtMax,
            d.sqrtMin,
            d.maxDay,
            d.crossed,
            d.newWallets,
            d.volumeMicroEth,
            d.pool,
            d.paid
        );
    }

    function winning(uint32 season) external view returns (uint32[QUESTIONS] memory) {
        return _seasons[season].winning;
    }

    function winnersWeight(uint32 season) external view returns (uint256[QUESTIONS] memory) {
        return _seasons[season].winnersWeight;
    }

    function capsuleOf(uint32 season, address owner)
        external
        view
        returns (bytes32 commit, bool revealed, uint16 hits, uint256 weight, bool claimed)
    {
        Capsule storage c = _capsules[season][owner];
        return (c.commit, c.revealed, c.hits, c.weight, c.claimed);
    }
}
