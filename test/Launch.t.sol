// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {TemoToken} from "../src/TemoToken.sol";
import {TemoHook} from "../src/TemoHook.sol";
import {TemoModel, WeightsStore} from "../src/TemoModel.sol";
import {Burrow} from "../src/Burrow.sol";
import {FeeTill} from "../src/FeeTill.sol";
import {Seeder} from "../src/Seeder.sol";
import {ITemoModel, IMoleProof, ITemoHook, ITemoToken, IPriceFeed} from "../src/interfaces/ITemo.sol";
import {TradeRecord} from "../src/libraries/TradeRecord.sol";

contract MockProof is IMoleProof {
    bool public proven = true;
    address public mole;

    constructor(address m) {
        mole = m;
    }
}

contract MockFeed is IPriceFeed {
    int256 public answer = 2500e8;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

contract WeightsFactory {
    function make(bytes memory data) external returns (address) {
        return WeightsStore.create(data);
    }
}

/// @notice Full launch on a mainnet fork: real PoolManager and PositionManager, our contracts, the dev buy, trades
///         through the hook, a whole season with capsules. Run with --fork-url.
contract LaunchTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IPositionManager constant POSM = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    address constant PLATFORM = 0xD88539d3c4C460136a733A3Fd60cf6BF269079da;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // fresh addresses: well-known test keys carry EIP-7702 delegations to sweepers on mainnet
    address mole = address(uint160(uint256(keccak256("temo mole 2026"))));
    address dev = address(uint160(uint256(keccak256("temo dev 2026"))));
    address alice = address(uint160(uint256(keccak256("temo alice 2026"))));
    address bob = address(uint160(uint256(keccak256("temo bob 2026"))));

    TemoToken token;
    TemoHook hook;
    TemoModel model;
    Burrow burrow;
    FeeTill platformTill;
    FeeTill devTill;
    MockProof proof;
    MockFeed feed;
    Seeder seeder;
    PoolSwapTest router;
    PoolKey key;

    uint160 constant SQRT_OPEN = 79228162514264337593543950336 * 1000; // 1e6 tokens per ETH -> sqrt(1e6) = 1000
    int24 openTick;

    function setUp() public {
        vm.createSelectFork(vm.envString("ETH_RPC"));
        address[4] memory fresh = [mole, dev, alice, bob];
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(fresh[i].code.length, 0, "test address carries code");
            assertEq(fresh[i].balance, 0, "test address not empty");
        }

        // satellites: the mole deploys them
        vm.startPrank(mole);
        proof = new MockProof(mole);
        feed = new MockFeed();
        WeightsFactory wf = new WeightsFactory();
        model = new TemoModel(mole, proof, wf.make(new bytes(177 * 2)));
        vm.stopPrank();

        // the launch graph (here: deployed by this test, which also plays the graph deployer)
        seeder = new Seeder(dev, POSM, address(this));
        token = new TemoToken(address(seeder));
        vm.prank(mole);
        burrow = new Burrow(mole, ITemoToken(address(token)), feed);
        platformTill = new FeeTill(PM, PLATFORM);
        devTill = new FeeTill(PM, dev);

        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory args = abi.encode(PM, address(token), address(model), address(burrow), address(platformTill), address(devTill), mole);
        bytes32 salt = _mine(flags, abi.encodePacked(type(TemoHook).creationCode, args));
        hook = new TemoHook{salt: salt}(PM, address(token), ITemoModel(address(model)), address(burrow), address(platformTill), address(devTill), mole);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, flags, "hook address flags");
        key = hook.poolKey();

        router = new PoolSwapTest(PM);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(address(this), 10 ether);
    }

    function _mine(uint160 flags, bytes memory initCode) internal view returns (bytes32 salt) {
        bytes32 h = keccak256(initCode);
        for (uint256 i = 0; i < 200_000; ++i) {
            salt = bytes32(i);
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, h)))));
            if (uint160(a) & Hooks.ALL_HOOK_MASK == flags && a.code.length == 0) return salt;
        }
        revert("no salt");
    }

    function _ignite() internal returns (uint256 mainId) {
        openTick = TickMath.getTickAtSqrtPrice(SQRT_OPEN);
        Seeder.IgniteParams memory p = Seeder.IgniteParams({
            sqrtPriceX96: SQRT_OPEN,
            tickLower: -30_000,
            tickUpper: openTick,
            minTokensOut: 1,
            buyEth: 0.07 ether
        });
        mainId = seeder.ignite{value: 0.1 ether}(address(token), address(hook), p);
        // the mole binds the hook now that it exists
        vm.startPrank(mole);
        burrow.bindHook(ITemoHook(address(hook)));
        model.setHook(ITemoHook(address(hook)));
        vm.stopPrank();
    }

    function _buy(address who, uint256 ethIn, bytes memory hookData) internal returns (uint256 got) {
        uint256 before = token.balanceOf(who);
        vm.prank(who, who);
        router.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
        got = token.balanceOf(who) - before;
    }

    function _sell(address who, uint256 tokensIn) internal returns (uint256 ethOut) {
        uint256 before = who.balance;
        vm.startPrank(who, who);
        token.approve(address(router), tokensIn);
        router.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        ethOut = who.balance - before;
    }

    // ================= tests =================

    function test_ignite() public {
        uint256 mainId = _ignite();
        assertTrue(seeder.ignited());
        assertEq(hook.launchedAt(), uint40(block.timestamp));
        assertEq(burrow.launchedAt(), uint40(block.timestamp));
        // both positions are owned by 0xdEaD, the seeder and the dev hold no tokens
        assertEq(IERC721(address(POSM)).ownerOf(mainId), DEAD);
        assertEq(IERC721(address(POSM)).ownerOf(mainId + 1), DEAD);
        assertEq(token.balanceOf(address(seeder)), 0);
        assertEq(token.balanceOf(dev), 0);
        assertEq(token.balanceOf(address(this)), 0);
        // the whole remaining supply sits in the pool
        assertEq(token.balanceOf(address(PM)), token.totalSupply(), "pool holds every token left");
        assertLt(token.totalSupply(), token.SUPPLY(), "leftover was burned");
        // the launch buy paid the normal fee: platform 0.30% of the 0.07 ETH buy, the mole got ETH, the burrow got ETH
        assertEq(PM.balanceOf(address(platformTill), 0), 0.07 ether * 3_000 / 1_000_000, "platform fee on the launch buy");
        assertGt(mole.balance, 0);
        assertGt(address(burrow).balance, 0);
        assertEq(hook.recordCount(), 1);
        emit log_named_uint("tokens burned", token.SUPPLY() - token.totalSupply());
        emit log_named_uint("mole gas received (wei)", mole.balance);
    }

    function test_feesSplitOnBuyAndSell() public {
        _ignite();
        uint256 platformBefore = PM.balanceOf(address(platformTill), 0);
        uint256 devBefore = PM.balanceOf(address(devTill), 0);
        uint256 moleBefore = mole.balance;
        uint256 burrowBefore = address(burrow).balance;

        uint256 got = _buy(alice, 1 ether, "");
        assertGt(got, 0);
        // zero weights -> score 5000 -> capsule 0.6% -> total 0.3 + 0.9 + 0.1 + 0.6 = 1.9% of 1 ETH
        assertEq(PM.balanceOf(address(platformTill), 0) - platformBefore, 0.003 ether, "platform 0.3%");
        assertEq(PM.balanceOf(address(devTill), 0) - devBefore, 0.009 ether, "dev 0.9%");
        assertEq(mole.balance - moleBefore, 0.001 ether, "mole 0.1%");
        assertEq(address(burrow).balance - burrowBefore, 0.006 ether, "capsule 0.6%");
        assertEq(hook.recordCount(), 2);

        // sell everything back: fee on the ETH output leg
        uint256 ethOut = _sell(alice, got);
        assertGt(ethOut, 0);
        assertEq(hook.recordCount(), 3);
        uint256 rec = hook.records(2);
        assertFalse(TradeRecord.isBuy(rec));
        assertTrue(TradeRecord.labelFinal(rec));
        assertEq(TradeRecord.label(rec), 100, "sold within 10 minutes = bot");
        // alice's position closed with label 100
        uint256 buyRec = hook.records(1);
        uint32 pos = TradeRecord.positionId(buyRec);
        assertEq(hook.positions(pos) & 0xff, 100);

        // tills pay out
        platformTill.collect();
        assertEq(PM.balanceOf(address(platformTill), 0), 0);
        uint256 devEthBefore = dev.balance;
        devTill.collect();
        assertGt(dev.balance, devEthBefore);
    }

    function test_moleCapRoutesToDev() public {
        _ignite();
        vm.deal(mole, 0.1 ether);
        uint256 devBefore = PM.balanceOf(address(devTill), 0);
        _buy(alice, 1 ether, "");
        assertEq(mole.balance, 0.1 ether, "mole at cap gets nothing");
        assertEq(PM.balanceOf(address(devTill), 0) - devBefore, 0.010 ether, "dev gets 0.9% + 0.1%");
    }

    function test_holdLabels() public {
        _ignite();
        uint256 got = _buy(bob, 0.5 ether, "");
        vm.warp(block.timestamp + 3 hours);
        _sell(bob, got / 2); // half after 3h: trader (50)
        vm.warp(block.timestamp + 10 hours);
        _sell(bob, got / 2); // rest after 13h: strategist (25)
        uint256 buyRec = hook.records(1);
        uint32 pos = TradeRecord.positionId(buyRec);
        // weighted: 50 * 0.5 + 25 * 0.5 = 37
        assertEq(hook.positions(pos) & 0xff, 37);
    }

    function test_settleAfterTtl() public {
        _ignite();
        _buy(bob, 0.5 ether, "");
        uint32 pos = TradeRecord.positionId(hook.records(1));
        hook.settle(bob);
        assertEq(hook.positions(pos), 0, "not yet");
        vm.warp(block.timestamp + 20 hours);
        hook.settle(bob);
        assertEq(hook.positions(pos), 1 << 8, "held: label 0, closed");
    }

    function test_previewFee() public {
        _ignite();
        (uint16 score, uint24 pips) = hook.previewFee(alice, true, 1 ether);
        assertEq(score, 5000);
        assertEq(pips, 6000);
    }

    function test_seasonEndToEnd() public {
        _ignite();
        uint256 t0 = block.timestamp;
        // window 1 is open from launch: alice buys with a capsule in hookData, bob buries one directly
        uint8[9] memory aliceAnswers;
        bytes32 aliceSalt = keccak256("alice");
        uint8[9] memory bobAnswers;
        bytes32 bobSalt = keccak256("bob");
        // bob guesses that nothing crosses (q7 = 0), alice guesses the same + day 0 peak (q8)
        aliceAnswers[6] = 0;
        aliceAnswers[7] = 0;
        bobAnswers[6] = 0;
        bobAnswers[7] = 3; // wrong on purpose

        uint256 aliceTokens = _buy(alice, 2 ether, abi.encode(keccak256(abi.encode(alice, uint32(1), aliceAnswers, aliceSalt)), bytes("ct")));
        uint256 bobTokens = _buy(bob, 1 ether, "");
        vm.prank(bob);
        burrow.bury(keccak256(abi.encode(bob, uint32(1), bobAnswers, bobSalt)), "ct2");
        assertEq(burrow.capsuleCount(1), 2);
        (,,,,,,,,,, uint256 poolAfterWindow,) = burrow.seasonInfo(1);
        assertGt(poolAfterWindow, 0, "fees in window 1 fund season 1");

        // season 1 starts: trades inside it move the metrics
        vm.warp(t0 + 24 hours + 1);
        _buy(alice, 0.2 ether, "");
        vm.warp(block.timestamp + 2 days);
        _sell(bob, bobTokens / 4);
        (bool started,,,,,,,, uint32 newWallets,,,) = burrow.seasonInfo(1);
        assertTrue(started);
        assertEq(newWallets, 0, "alice and bob were seen before the season");

        // season ends; resolve; winners reveal
        vm.warp(t0 + 24 hours + 7 days + 1);
        burrow.resolve(1);
        uint32[9] memory win = burrow.winning(1);
        emit log_named_uint("win q1 cap bucket", win[0]);
        emit log_named_uint("win q7 crossed", win[6]);
        emit log_named_uint("win q8 maxDay", win[7]);
        assertEq(win[6], 0, "nothing doubled or halved");

        burrow.reveal(1, alice, aliceAnswers, aliceSalt);
        burrow.reveal(1, bob, bobAnswers, bobSalt);
        (, bool aRev, uint16 aHits, uint256 aWeight,) = burrow.capsuleOf(1, alice);
        (, bool bRev, uint16 bHits, uint256 bWeight,) = burrow.capsuleOf(1, bob);
        assertTrue(aRev && bRev);
        assertEq(aWeight, aliceTokens, "alice held: weight = balance at start (she bought more later, no increase)");
        assertEq(bWeight, bobTokens - bobTokens / 4, "bob sold a quarter: weight = balance at end");
        assertTrue(aHits & (1 << 6) != 0);
        assertTrue(bHits & (1 << 6) != 0);
        assertTrue(bHits & (1 << 7) == 0);

        vm.expectRevert(Burrow.ClaimNotOpen.selector);
        vm.prank(alice);
        burrow.claim(1);

        vm.warp(block.timestamp + 24 hours + 1);
        uint256 aPrize = burrow.prizeOf(1, alice);
        uint256 bPrize = burrow.prizeOf(1, bob);
        assertGt(aPrize, bPrize, "alice guessed one more question");
        uint256 aBefore = alice.balance;
        vm.prank(alice);
        burrow.claim(1);
        assertEq(alice.balance - aBefore, aPrize);
        vm.prank(bob);
        burrow.claim(1);
        vm.prank(bob);
        vm.expectRevert(Burrow.NothingToClaim.selector);
        burrow.claim(1);

        // unclaimed shares roll over after 30 days
        vm.warp(block.timestamp + 30 days + 1);
        burrow.rollover(1);
        (,,,,,,,,,, uint256 pool1, uint256 paid1) = burrow.seasonInfo(1);
        assertEq(pool1, paid1);
    }

    function test_gasOfSwap() public {
        _ignite();
        _buy(alice, 0.3 ether, ""); // warm alice
        vm.prank(alice, alice);
        uint256 g = gasleft();
        router.swap{value: 0.3 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -0.3 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        emit log_named_uint("buy gas via test router (warm wallet)", g - gasleft());
    }
}
