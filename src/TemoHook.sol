// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: <fill in before deploy>
// X:       <fill in before deploy>

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FeeCalc} from "./libraries/FeeCalc.sol";
import {TradeRecord} from "./libraries/TradeRecord.sol";
import {ITemoModel, IBurrow} from "./interfaces/ITemo.sol";

/// @title TemoHook
/// @notice The one permanent hook of the TEMO/ETH pool. Immutable, no owner.
///  - every swap pays a fee in ETH: platform 0.3% + dev 0.9% + mole 0.1% + capsule pool 0.2..1.0%
///  - the capsule share is set per trade by the model: 0.2% + 0.8% * dump score; the bounds are constants here
///  - the model is asked with a gas-capped STATICCALL; any failure means the middle score
///  - every trade is written as one packed record for training and for the on-chain judge
///  - a wallet is its tx.origin; the hook keeps one open position per wallet to label buys later
///  - season metrics are pushed to the burrow; hookData may carry a capsule to bury in the same transaction
contract TemoHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using TradeRecord for uint256;

    // ---------------- constants ----------------
    uint24 public constant PLATFORM_FEE = 3_000; // 0.30%
    uint24 public constant DEV_FEE = 9_000; // 0.90%
    uint24 public constant MOLE_FEE = 1_000; // 0.10%
    uint24 public constant CAPSULE_MIN = 2_000; // 0.20%
    uint24 public constant CAPSULE_MAX = 10_000; // 1.00%
    uint256 public constant MOLE_GAS_CAP = 0.1 ether;
    uint256 public constant MODEL_GAS_CAP = 90_000;
    uint256 public constant GAS_RESERVE = 40_000;
    uint256 public constant POSITION_TTL = 20 hours;
    uint16 public constant MID_SCORE = 5_000;
    uint256 private constant ETH_ID = 0;

    // ---------------- wiring ----------------
    IPoolManager public immutable poolManager;
    address public immutable token;
    ITemoModel public immutable model;
    address public immutable burrow;
    address public immutable platformTill;
    address public immutable devTill;
    address public immutable mole;

    // ---------------- state ----------------
    PoolId public poolId;
    uint40 public launchedAt;
    uint256[] public records;
    uint32 public positionCount;
    mapping(uint32 id => uint256 packed) public positions; // 0 = open; closed: label | 1 << 8
    uint32 public walletsSeen;
    uint32 public modelFailures;

    // Two storage slots. A wallet has at most one open position: buys merge into it, sells take from it.
    struct Profile {
        uint40 firstSeen;
        uint40 lastTrade;
        uint16 trades24h;
        uint40 windowStart;
        uint32 posId;
        uint40 openTs; // first buy of the position: base of the hold time
        uint40 lastBuyTs; // last buy: base of POSITION_TTL, so every buy is observed for the full TTL
        uint96 openAmount; // tokens still held in the position
        uint96 soldAmount; // tokens sold out of it
        uint40 capsuleTs;
        uint24 labelAcc; // sum(label_i * fractionBps_i), fractions relative to openAmount + soldAmount; max 1e6
    }

    mapping(address origin => Profile) public profiles;

    struct Hour {
        uint40 start;
        uint96 volume;
    }

    Hour public hour;

    // transient slots
    uint256 private constant T_PIPS = uint256(keccak256("temo.hook.pips"));
    uint256 private constant T_RECORD = uint256(keccak256("temo.hook.record"));
    uint256 private constant T_SQRT = uint256(keccak256("temo.hook.sqrt"));

    error NotPoolManager();
    error HookNotImplemented();
    error WrongPool();
    error OutOfGasBudget();
    error PartialNativeFill();
    error NotBurrow();

    event FeeTaken(bool buy, uint256 gross, uint256 platform, uint256 dev, uint256 mole, uint256 capsule, uint16 score);
    event Trade(uint256 indexed index, address indexed origin, uint256 record, uint16 score);
    event PositionClosed(address indexed origin, uint32 indexed id, uint8 label);
    event ModelFailed(uint32 count);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address token_,
        ITemoModel model_,
        address burrow_,
        address platformTill_,
        address devTill_,
        address mole_
    ) {
        poolManager = poolManager_;
        token = token_;
        model = model_;
        burrow = burrow_;
        platformTill = platformTill_;
        devTill = devTill_;
        mole = mole_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ================= views =================

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 1,
            hooks: IHooks(address(this))
        });
    }

    function recordCount() external view returns (uint256) {
        return records.length;
    }

    /// @notice What the mole thinks of `trader` for a trade of `ethAmount`: the score and the capsule share.
    function previewFee(address trader, bool buy, uint256 ethAmount) external view returns (uint16 score, uint24 capsulePips) {
        uint256 rec = _buildRecord(trader, buy, ethAmount, _sqrtNow());
        score = _ask(rec);
        capsulePips = _capsulePips(score);
    }

    // ================= initialize =================

    function beforeInitialize(address, PoolKey calldata key, uint160) external onlyPoolManager returns (bytes4) {
        if (
            PoolId.unwrap(poolId) != 0 || Currency.unwrap(key.currency0) != address(0)
                || Currency.unwrap(key.currency1) != token || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG || key.tickSpacing != 1
        ) revert WrongPool();
        poolId = key.toId();
        launchedAt = uint40(block.timestamp);
        return IHooks.beforeInitialize.selector;
    }

    // ================= swap =================

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert WrongPool();
        if (gasleft() < MODEL_GAS_CAP + GAS_RESERVE) revert OutOfGasBudget();

        uint160 sqrtP = _sqrtNow();
        bool buy = params.zeroForOne;
        uint256 ethGuess = _ethGuess(params, sqrtP);
        uint256 rec = _buildRecord(tx.origin, buy, ethGuess, sqrtP);
        uint16 score = _ask(rec);
        uint24 pips = _capsulePips(score) + DEV_FEE + MOLE_FEE;

        _tstore(T_PIPS, (uint256(score) << 24) | pips);
        _tstore(T_RECORD, rec);
        _tstore(T_SQRT, sqrtP);

        uint256 fee;
        if (_nativeSpecified(params)) {
            (uint256 gross, uint256 f) = _feeOnSpecified(params, pips);
            fee = f;
            _accrue(buy, gross, fee, pips, score);
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        uint256 packed = _tload(T_PIPS);
        uint24 pips = uint24(packed);
        uint16 score = uint16(packed >> 24);
        bool buy = params.zeroForOne;

        uint256 ethAmount = delta.amount0() < 0 ? uint256(-int256(delta.amount0())) : uint256(int256(delta.amount0()));
        int128 hookFee = _settleAfter(buy, params, ethAmount, pips, score);
        uint256 ethGross = _nativeSpecified(params) ? _grossOf(params, pips) : (params.amountSpecified < 0 ? ethAmount : ethAmount + uint256(uint128(hookFee)));

        uint256 tokenAmount = delta.amount1() < 0 ? uint256(-int256(delta.amount1())) : uint256(int256(delta.amount1()));
        _record(tx.origin, buy, tokenAmount, ethGross, _tload(T_RECORD), score);

        uint160 sqrtBefore = uint160(_tload(T_SQRT));
        IBurrow(burrow).onTrade(sqrtBefore, _sqrtNow(), ethGross, (_tload(T_RECORD) >> 122) & 1 == 1);

        if (hookData.length >= 96) {
            (bytes32 commit, bytes memory ciphertext) = abi.decode(hookData, (bytes32, bytes));
            IBurrow(burrow).buryFor(tx.origin, commit, ciphertext);
        }
        return (IHooks.afterSwap.selector, hookFee);
    }

    /// @dev ETH specified: assert the pool moved exactly the ETH the fee was computed on. Else: fee on the ETH leg.
    function _settleAfter(bool buy, SwapParams calldata params, uint256 ethAmount, uint24 pips, uint16 score)
        private
        returns (int128)
    {
        bool exactIn = params.amountSpecified < 0;
        if (_nativeSpecified(params)) {
            (uint256 g, uint256 f) = _feeOnSpecified(params, pips);
            if (ethAmount != (exactIn ? g - f : g)) revert PartialNativeFill();
            return 0;
        }
        uint24 total = pips + PLATFORM_FEE;
        uint256 fee = exactIn ? FeeCalc.onGross(ethAmount, total) : FeeCalc.onNet(ethAmount, total);
        _accrue(buy, exactIn ? ethAmount : ethAmount + fee, fee, pips, score);
        return fee.toInt128();
    }

    function _grossOf(SwapParams calldata params, uint24 pips) private pure returns (uint256 gross) {
        (gross,) = _feeOnSpecified(params, pips);
    }

    /// @dev ETH (currency0) is the specified side iff exactInput == zeroForOne.
    function _nativeSpecified(SwapParams calldata p) private pure returns (bool) {
        return (p.amountSpecified < 0) == p.zeroForOne;
    }

    function _feeOnSpecified(SwapParams calldata p, uint24 pips) private pure returns (uint256 gross, uint256 fee) {
        uint24 total = pips + PLATFORM_FEE;
        bool exactIn = p.amountSpecified < 0;
        uint256 requested = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        fee = exactIn ? FeeCalc.onGross(requested, total) : FeeCalc.onNet(requested, total);
        gross = exactIn ? requested : requested + fee;
    }

    /// @dev Split the fee and settle it: claims for the tills, ETH for the mole (while under its cap) and the burrow.
    function _accrue(bool buy, uint256 gross, uint256 fee, uint24 pips, uint16 score) private {
        if (fee == 0) return;
        uint256 platform = FeeCalc.share(gross, fee, PLATFORM_FEE);
        uint256 dev = FeeCalc.share(gross, fee, DEV_FEE);
        uint256 moleShare = FeeCalc.share(gross, fee, MOLE_FEE);
        uint256 capsule = fee - platform - dev - moleShare;
        if (platform != 0) poolManager.mint(platformTill, ETH_ID, platform);
        if (moleShare != 0) {
            if (mole.balance < MOLE_GAS_CAP) poolManager.take(CurrencyLibrary.ADDRESS_ZERO, mole, moleShare);
            else dev += moleShare;
        }
        if (dev != 0) poolManager.mint(devTill, ETH_ID, dev);
        if (capsule != 0) poolManager.take(CurrencyLibrary.ADDRESS_ZERO, burrow, capsule);
        emit FeeTaken(buy, gross, platform, dev, moleShare, capsule, score);
        pips; // the capsule share is implied by score; kept in the signature for clarity of the event's inputs
    }

    // ================= model =================

    function _capsulePips(uint16 score) private pure returns (uint24) {
        uint256 s = score > 10_000 ? 10_000 : score;
        return uint24(CAPSULE_MIN + (uint256(CAPSULE_MAX - CAPSULE_MIN) * s) / 10_000);
    }

    /// @dev Gas-capped STATICCALL, 32-byte answer, clamped. Anything else -> the middle score. A trader's gas
    ///      never changes the answer: the budget was checked before.
    function _ask(uint256 rec) private view returns (uint16) {
        (bool ok, uint256 v) = _staticcall32(address(model), abi.encodeCall(ITemoModel.score, (rec)), MODEL_GAS_CAP);
        if (!ok) return MID_SCORE;
        return v > 10_000 ? 10_000 : uint16(v);
    }

    function _staticcall32(address target, bytes memory data, uint256 gasCap) private view returns (bool ok, uint256 v) {
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(gasCap, target, add(data, 0x20), mload(data), out, 0x20)
            if iszero(eq(returndatasize(), 0x20)) { ok := 0 }
            v := mload(out)
        }
    }

    // ================= records & profiles =================

    function _buildRecord(address origin, bool buy, uint256 ethAmount, uint160 sqrtP) private view returns (uint256) {
        Profile memory p = profiles[origin];
        TradeRecord.Fields memory f;
        f.isBuy = buy;
        f.sizeBps = TradeRecord.clamp16(_sizeBps(ethAmount, sqrtP));
        f.minutesSince = TradeRecord.clamp24((block.timestamp - launchedAt) / 60);
        f.tipGwei = TradeRecord.clamp16(tx.gasprice > block.basefee ? (tx.gasprice - block.basefee) / 1 gwei : 0);
        f.trades24h = block.timestamp >= uint256(p.windowStart) + 24 hours ? 0 : p.trades24h;
        if (!buy && p.openTs != 0) f.holdMinutes = TradeRecord.clamp24((block.timestamp - p.openTs) / 60);
        if (p.capsuleTs != 0) {
            f.hasCapsule = true;
            f.capsuleDays = TradeRecord.clamp8((block.timestamp - p.capsuleTs) / 1 days);
        }
        Hour memory h = hour;
        f.hourVolume = TradeRecord.clamp16(block.timestamp / 1 hours == h.start / 1 hours ? h.volume / 1e16 : 0);
        f.firstSeen = p.firstSeen == 0;
        return TradeRecord.pack(f);
    }

    /// @dev Append the record, label sells, open or merge positions on buys, update the wallet and hour stats.
    function _record(address origin, bool buy, uint256 tokenAmount, uint256 ethGross, uint256 rec, uint16 score) private {
        Profile memory p = profiles[origin];
        uint256 now_ = block.timestamp;

        if (p.firstSeen == 0) {
            p.firstSeen = uint40(now_);
            ++walletsSeen;
        }
        if (now_ >= uint256(p.windowStart) + 24 hours) {
            p.windowStart = uint40(now_);
            p.trades24h = 0;
        }
        if (p.trades24h < type(uint16).max) ++p.trades24h;
        p.lastTrade = uint40(now_);

        // an expired open position closes first, with what has been accounted so far
        if (p.openTs != 0 && now_ >= uint256(p.lastBuyTs) + POSITION_TTL) _close(origin, p);

        if (buy) {
            if (p.openTs == 0) {
                p.posId = ++positionCount;
                p.openTs = uint40(now_);
                p.openAmount = 0;
                p.soldAmount = 0;
                p.labelAcc = 0;
            }
            uint256 total = uint256(p.openAmount) + p.soldAmount;
            uint256 merged = uint256(p.openAmount) + tokenAmount;
            if (merged > type(uint96).max) merged = type(uint96).max;
            // fractions stay relative to the whole position: rescale what was accumulated so far
            if (total != 0) p.labelAcc = uint24(uint256(p.labelAcc) * total / (merged + p.soldAmount));
            p.openAmount = uint96(merged);
            p.lastBuyTs = uint40(now_);
            rec |= uint256(p.posId) << 132; // label will live in positions[posId]
        } else {
            uint256 since = p.openTs != 0 ? p.openTs : p.firstSeen;
            uint8 label = TradeRecord.labelForHold(now_ - since);
            rec |= uint256(label) << 123;
            rec |= uint256(1) << 131;
            if (p.openTs != 0 && p.openAmount != 0) {
                uint256 sold = tokenAmount >= p.openAmount ? p.openAmount : tokenAmount;
                uint256 total = uint256(p.openAmount) + p.soldAmount;
                uint256 frac = sold * 10_000 / total; // bps of the whole position
                p.labelAcc = uint24(uint256(p.labelAcc) + uint256(label) * frac); // label% * bps
                p.soldAmount = uint96(uint256(p.soldAmount) + sold);
                p.openAmount = uint96(uint256(p.openAmount) - sold);
                if (p.openAmount == 0) _close(origin, p);
            }
        }
        profiles[origin] = p;

        uint256 index = records.length;
        records.push(rec);
        emit Trade(index, origin, rec, score);

        Hour memory h = hour;
        if (now_ / 1 hours != h.start / 1 hours) {
            h.start = uint40(now_);
            h.volume = 0;
        }
        uint256 vol = uint256(h.volume) + ethGross;
        h.volume = vol > type(uint96).max ? type(uint96).max : uint96(vol);
        hour = h;
    }

    /// @dev Final label of a position = sum(label_i * fraction_i) over everything bought into it; the unsold remainder counts as held (0).
    function _close(address origin, Profile memory p) private {
        uint8 label = uint8((uint256(p.labelAcc) + 5_000) / 10_000); // rounded once, to the nearest
        positions[p.posId] = uint256(label) | (1 << 8);
        emit PositionClosed(origin, p.posId, label);
        p.openTs = 0;
        p.lastBuyTs = 0;
        p.openAmount = 0;
        p.soldAmount = 0;
        p.labelAcc = 0;
        p.posId = 0;
    }

    /// @notice Close a wallet's open position once POSITION_TTL passed since its last buy: the rest is labeled "held".
    function settle(address origin) external {
        Profile memory p = profiles[origin];
        if (p.openTs == 0 || block.timestamp < uint256(p.lastBuyTs) + POSITION_TTL) return;
        _close(origin, p);
        profiles[origin] = p;
    }

    function settleMany(address[] calldata origins) external {
        for (uint256 i = 0; i < origins.length; ++i) {
            Profile memory p = profiles[origins[i]];
            if (p.openTs == 0 || block.timestamp < uint256(p.lastBuyTs) + POSITION_TTL) continue;
            _close(origins[i], p);
            profiles[origins[i]] = p;
        }
    }

    /// @notice The burrow reports a capsule so the model can see it.
    function noteCapsule(address owner, uint40 timestamp) external {
        if (msg.sender != burrow) revert NotBurrow();
        profiles[owner].capsuleTs = timestamp;
    }

    // ================= helpers =================

    function _sqrtNow() private view returns (uint160 sqrtP) {
        (sqrtP,,,) = poolManager.getSlot0(poolId);
    }

    /// @dev Trade size relative to the pool's virtual ETH reserve (liquidity * 2^96 / sqrtP), in bps.
    function _sizeBps(uint256 ethAmount, uint160 sqrtP) private view returns (uint256) {
        uint128 liquidity = poolManager.getLiquidity(poolId);
        if (liquidity == 0 || sqrtP == 0) return type(uint16).max;
        uint256 reserve0 = FullMath.mulDiv(liquidity, 2 ** 96, sqrtP);
        if (reserve0 == 0) return type(uint16).max;
        return ethAmount * 10_000 / reserve0;
    }

    /// @dev ETH side of the swap for the features: exact when ETH is specified, spot-priced otherwise.
    function _ethGuess(SwapParams calldata p, uint160 sqrtP) private pure returns (uint256) {
        uint256 amount = p.amountSpecified < 0 ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        if (_nativeSpecified(p)) return amount;
        if (sqrtP == 0) return 0;
        // tokens -> ETH: amount * (2^96 / sqrtP)^2
        return FullMath.mulDiv(FullMath.mulDiv(amount, 2 ** 96, sqrtP), 2 ** 96, sqrtP);
    }

    function _tstore(uint256 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _tload(uint256 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    // ================= unused callbacks =================

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
