// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IPoolAddressesProvider} from "../interfaces/IPoolAddressesProvider.sol";
import {IPriceOracleSentinel} from "./interfaces/IPriceOracleSentinel.sol";

/// @notice What the guard needs from a guarded market's price source (`LighterCorePriceSource`).
interface ILighterMarketPriceSource {
    function MARKET_ID() external view returns (uint16);

    function latestAnswer() external view returns (int256);
}

/// @title LuminaPriceGuard
/// @notice Aave `IPriceOracleSentinel` (set via `PoolAddressesProvider.setPriceOracleSentinel`)
/// and borrow guard for `LighterDualOracle`. Valuation always uses the `READ_CORE` index price;
/// this contract only decides whether **borrows** are allowed.
///
/// Borrows are allowed only while, for every guarded market:
///  1. the keeper's reference is at most `maxRefAge` old;
///  2. the Core index price changed at most `maxCorePriceAge` ago, as recorded on-chain by the
///     permissionless `poke` (a keeper key cannot fake a Core price change);
///  3. the live Core price is readable and within `maxDeviationBps` of the reference;
/// and the guardian has not paused borrows.
///
/// Trust model: the keeper is trusted for reference freshness only. It can stop borrows (go
/// silent or post a deviating price) but can never change a valuation price or block
/// liquidations (`isLiquidationAllowed()` is always true). A compromised keeper combined with a
/// Core freeze keeps borrows open for at most `maxCorePriceAge`.
contract LuminaPriceGuard is IPriceOracleSentinel {
    // ------------------------------------------------------------------ constants & bounds

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MARKETS = 8;

    uint256 public constant MIN_REF_AGE = 30;
    uint256 public constant MAX_REF_AGE = 1 hours;
    uint256 public constant MIN_DEVIATION_BPS = 10;
    uint256 public constant MAX_DEVIATION_BPS = 2_000;
    uint256 public constant MIN_CORE_PRICE_AGE = 60;
    uint256 public constant MAX_CORE_PRICE_AGE = 30 days;

    /// @notice Reasons returned by `borrowStatus()`.
    enum Status {
        OK,
        PAUSED,
        NO_MARKETS,
        NO_REFERENCE,
        REFERENCE_STALE,
        CORE_PRICE_STALE,
        CORE_READ_FAILED,
        DEVIATION
    }

    struct Market {
        bool guarded;
        uint8 index; // position in `_marketIds`
        ILighterMarketPriceSource source;
        uint256 refPrice; // 8 decimals
        uint64 refObservedAt;
        uint256 corePrice; // 8 decimals, last value recorded by `_poke`
        uint64 lastCoreChangeAt;
    }

    // ------------------------------------------------------------------------------- state

    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;

    address public guardian;
    address public pendingGuardian;
    address public keeper;
    bool public borrowsPaused;

    uint256 public maxRefAge;
    uint256 public maxDeviationBps;
    uint256 public maxCorePriceAge;

    mapping(uint16 => Market) private _markets;
    uint16[] private _marketIds;

    // ------------------------------------------------------------------------------ events

    event GuardianTransferStarted(address indexed currentGuardian, address indexed pendingGuardian);
    event GuardianTransferred(address indexed previousGuardian, address indexed newGuardian);
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);
    event BorrowsPausedSet(bool paused);
    event MaxRefAgeUpdated(uint256 maxRefAge);
    event MaxDeviationBpsUpdated(uint256 maxDeviationBps);
    event MaxCorePriceAgeUpdated(uint256 maxCorePriceAge);
    event MarketAdded(uint16 indexed marketId, address source, uint256 corePrice);
    event MarketRemoved(uint16 indexed marketId);
    event ReferencePosted(uint16 indexed marketId, uint256 price, uint64 observedAt);
    event CorePriceChanged(uint16 indexed marketId, uint256 previousPrice, uint256 newPrice);

    // ------------------------------------------------------------------------------ errors

    error NotGuardian();
    error NotPendingGuardian();
    error NotKeeper();
    error ZeroAddress();
    error OutOfBounds(uint256 value, uint256 min, uint256 max);
    error MarketAlreadyGuarded(uint16 marketId);
    error MarketNotGuarded(uint16 marketId);
    error TooManyMarkets();
    error SourceMarketMismatch(uint16 marketId, uint16 sourceMarketId);
    error InvalidCorePrice(uint16 marketId, int256 price);
    error InvalidReferencePrice(uint256 price);
    error ObservedAtNotIncreasing(uint64 observedAt, uint64 lastObservedAt);
    error ObservedAtInFuture(uint64 observedAt, uint256 nowTimestamp);
    error Unsupported();

    // --------------------------------------------------------------------------- modifiers

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    // ------------------------------------------------------------------------- constructor

    constructor(
        IPoolAddressesProvider addressesProvider,
        address guardian_,
        address keeper_,
        uint256 maxRefAge_,
        uint256 maxDeviationBps_,
        uint256 maxCorePriceAge_
    ) {
        if (address(addressesProvider) == address(0) || guardian_ == address(0)) revert ZeroAddress();
        ADDRESSES_PROVIDER = addressesProvider;
        guardian = guardian_;
        emit GuardianTransferred(address(0), guardian_);
        keeper = keeper_;
        emit KeeperUpdated(address(0), keeper_);
        _setMaxRefAge(maxRefAge_);
        _setMaxDeviationBps(maxDeviationBps_);
        _setMaxCorePriceAge(maxCorePriceAge_);
    }

    // ------------------------------------------------------------------- sentinel interface

    /// @inheritdoc IPriceOracleSentinel
    function isBorrowAllowed() external view override returns (bool) {
        (Status status,) = borrowStatus();
        return status == Status.OK;
    }

    /// @notice Always true. Aave bypasses the sentinel below HF 0.95 anyway, so a guard-level
    /// liquidation switch would be misleading; the emergency stop is the reserve-pause runbook.
    function isLiquidationAllowed() external pure override returns (bool) {
        return true;
    }

    function setSequencerOracle(address) external pure override {
        revert Unsupported();
    }

    function setGracePeriod(uint256) external pure override {
        revert Unsupported();
    }

    function getSequencerOracle() external pure override returns (address) {
        return address(0);
    }

    function getGracePeriod() external pure override returns (uint256) {
        return 0;
    }

    // ------------------------------------------------------------------------- borrow logic

    /// @notice Why borrows are (not) allowed: `OK`, or the first failing check and the market it
    /// failed for (0 when not market-specific). Never reverts.
    function borrowStatus() public view returns (Status status, uint16 marketId) {
        if (borrowsPaused) return (Status.PAUSED, 0);
        uint256 count = _marketIds.length;
        if (count == 0) return (Status.NO_MARKETS, 0);
        for (uint256 i = 0; i < count; ++i) {
            marketId = _marketIds[i];
            status = _marketStatus(_markets[marketId]);
            if (status != Status.OK) return (status, marketId);
        }
        return (Status.OK, 0);
    }

    function _marketStatus(Market storage market) private view returns (Status) {
        uint64 observedAt = market.refObservedAt;
        if (observedAt == 0) return Status.NO_REFERENCE;
        if (block.timestamp - observedAt > maxRefAge) return Status.REFERENCE_STALE;
        // Only the stored change time counts: a live price that differs from the stored one is
        // NOT treated as fresh, so a keeper that stops poking cannot keep borrows open.
        if (block.timestamp - market.lastCoreChangeAt > maxCorePriceAge) return Status.CORE_PRICE_STALE;

        uint256 core;
        try market.source.latestAnswer() returns (int256 answer) {
            if (answer <= 0) return Status.CORE_READ_FAILED;
            core = uint256(answer);
        } catch {
            return Status.CORE_READ_FAILED;
        }

        uint256 ref = market.refPrice; // <= type(uint128).max (enforced when posted)
        uint256 diff = core > ref ? core - ref : ref - core;
        // diff > ref means > 100% deviation (above any allowed bound); checking it first also
        // keeps `diff * BPS` from overflowing for an extreme core price.
        if (diff > ref || diff * BPS > maxDeviationBps * ref) return Status.DEVIATION;
        return Status.OK;
    }

    // ----------------------------------------------------------------------- keeper & poke

    /// @notice Keeper posts an off-chain reference price (8 decimals) observed at `observedAt`,
    /// then pokes the Core price, so one keeper tx per heartbeat keeps both checks alive.
    /// Reverts if the Core read fails. (Spec name: `reference`, a reserved word in Solidity.)
    function postReference(uint16 marketId, uint256 price, uint64 observedAt) external onlyKeeper {
        Market storage market = _guardedMarket(marketId);
        if (price == 0 || price > type(uint128).max) revert InvalidReferencePrice(price);
        if (observedAt <= market.refObservedAt) revert ObservedAtNotIncreasing(observedAt, market.refObservedAt);
        if (observedAt > block.timestamp) revert ObservedAtInFuture(observedAt, block.timestamp);
        market.refPrice = price;
        market.refObservedAt = observedAt;
        emit ReferencePosted(marketId, price, observedAt);
        _poke(marketId, market);
    }

    /// @notice Permissionless: records the current Core index price and, if it changed, the
    /// time of the change. Reverts if the Core read fails.
    function poke(uint16 marketId) external {
        _poke(marketId, _guardedMarket(marketId));
    }

    function _poke(uint16 marketId, Market storage market) private {
        uint256 core = _readCore(marketId, market.source);
        uint256 previous = market.corePrice;
        if (core != previous) {
            market.corePrice = core;
            market.lastCoreChangeAt = uint64(block.timestamp);
            emit CorePriceChanged(marketId, previous, core);
        }
    }

    function _readCore(uint16 marketId, ILighterMarketPriceSource source) private view returns (uint256) {
        int256 answer = source.latestAnswer();
        if (answer <= 0) revert InvalidCorePrice(marketId, answer);
        return uint256(answer);
    }

    // ------------------------------------------------------------------------- guardian admin

    function addMarket(uint16 marketId, ILighterMarketPriceSource source) external onlyGuardian {
        if (address(source) == address(0)) revert ZeroAddress();
        Market storage market = _markets[marketId];
        if (market.guarded) revert MarketAlreadyGuarded(marketId);
        if (_marketIds.length >= MAX_MARKETS) revert TooManyMarkets();
        uint16 sourceMarketId = source.MARKET_ID();
        if (sourceMarketId != marketId) revert SourceMarketMismatch(marketId, sourceMarketId);

        uint256 core = _readCore(marketId, source);
        market.guarded = true;
        market.index = uint8(_marketIds.length);
        market.source = source;
        market.refPrice = 0;
        market.refObservedAt = 0;
        market.corePrice = core;
        market.lastCoreChangeAt = uint64(block.timestamp);
        _marketIds.push(marketId);
        emit MarketAdded(marketId, address(source), core);
    }

    /// @dev Removing the last market leaves no guarded market, which blocks all borrows.
    function removeMarket(uint16 marketId) external onlyGuardian {
        Market storage market = _guardedMarket(marketId);
        uint256 index = market.index;
        uint256 lastIndex = _marketIds.length - 1;
        if (index != lastIndex) {
            uint16 moved = _marketIds[lastIndex];
            _marketIds[index] = moved;
            _markets[moved].index = uint8(index);
        }
        _marketIds.pop();
        delete _markets[marketId];
        emit MarketRemoved(marketId);
    }

    function setBorrowsPaused(bool paused) external onlyGuardian {
        borrowsPaused = paused;
        emit BorrowsPausedSet(paused);
    }

    function setKeeper(address newKeeper) external onlyGuardian {
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setMaxRefAge(uint256 value) external onlyGuardian {
        _setMaxRefAge(value);
    }

    function setMaxDeviationBps(uint256 value) external onlyGuardian {
        _setMaxDeviationBps(value);
    }

    function setMaxCorePriceAge(uint256 value) external onlyGuardian {
        _setMaxCorePriceAge(value);
    }

    function transferGuardian(address newGuardian) external onlyGuardian {
        if (newGuardian == address(0)) revert ZeroAddress();
        pendingGuardian = newGuardian;
        emit GuardianTransferStarted(guardian, newGuardian);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotPendingGuardian();
        emit GuardianTransferred(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    // ------------------------------------------------------------------------------- views

    function marketIds() external view returns (uint16[] memory) {
        return _marketIds;
    }

    function getMarket(uint16 marketId)
        external
        view
        returns (
            bool guarded,
            address source,
            uint256 refPrice,
            uint64 refObservedAt,
            uint256 corePrice,
            uint64 lastCoreChangeAt
        )
    {
        Market storage m = _markets[marketId];
        return (m.guarded, address(m.source), m.refPrice, m.refObservedAt, m.corePrice, m.lastCoreChangeAt);
    }

    // ----------------------------------------------------------------------------- internal

    function _guardedMarket(uint16 marketId) private view returns (Market storage market) {
        market = _markets[marketId];
        if (!market.guarded) revert MarketNotGuarded(marketId);
    }

    function _setMaxRefAge(uint256 value) private {
        if (value < MIN_REF_AGE || value > MAX_REF_AGE) revert OutOfBounds(value, MIN_REF_AGE, MAX_REF_AGE);
        maxRefAge = value;
        emit MaxRefAgeUpdated(value);
    }

    function _setMaxDeviationBps(uint256 value) private {
        if (value < MIN_DEVIATION_BPS || value > MAX_DEVIATION_BPS) {
            revert OutOfBounds(value, MIN_DEVIATION_BPS, MAX_DEVIATION_BPS);
        }
        maxDeviationBps = value;
        emit MaxDeviationBpsUpdated(value);
    }

    function _setMaxCorePriceAge(uint256 value) private {
        if (value < MIN_CORE_PRICE_AGE || value > MAX_CORE_PRICE_AGE) {
            revert OutOfBounds(value, MIN_CORE_PRICE_AGE, MAX_CORE_PRICE_AGE);
        }
        maxCorePriceAge = value;
        emit MaxCorePriceAgeUpdated(value);
    }
}
