// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {LighterPriceSourceBase} from "./LighterPriceSourceBase.sol";
import {LighterReadCore} from "./LighterReadCore.sol";

/// @title LighterCorePriceSource
/// @notice Aave price source (8 decimals, USD) backed by the index price of one Lighter Core
/// perp market, read live through the `READ_CORE` precompile.
/// @dev Uses `indexPrice`, never `markPrice`: mark is derived from Lighter's own (thin) book.
/// Every failure reverts; the source never returns 0. Freshness is not provable on-chain
/// (no Core timestamp is exposed); `LuminaPriceGuard` bounds it instead.
contract LighterCorePriceSource is LighterPriceSourceBase {
    uint256 public constant MIN_READ_GAS_STIPEND = 25_000;
    uint256 public constant MAX_READ_GAS_STIPEND = 1_000_000;
    uint8 public constant MAX_PRICE_DECIMALS = 18;

    /// @notice Lighter Core market id (must be a perp market).
    uint16 public immutable MARKET_ID;
    /// @notice Core `supported_price_decimals` of the market: `indexPrice` is scaled by 10^this.
    uint8 public immutable PRICE_DECIMALS;
    /// @notice Inclusive sanity bounds on the scaled price (8 decimals).
    uint256 public immutable MIN_PRICE;
    uint256 public immutable MAX_PRICE;
    /// @notice Gas forwarded to `READ_CORE`; a failed read burns at most this much.
    uint256 public immutable READ_GAS_STIPEND;

    uint256 private immutable SCALE_MUL;
    uint256 private immutable SCALE_DIV;

    string private _description;

    error InvalidConfig();
    error NotPerpMarket(uint16 marketId, uint8 marketType);
    error ZeroPrice(uint16 marketId);
    error PriceOutOfBounds(uint16 marketId, uint256 price, uint256 minPrice, uint256 maxPrice);

    constructor(
        uint16 marketId,
        uint8 priceDecimals,
        uint256 minPrice,
        uint256 maxPrice,
        uint256 readGasStipend,
        string memory description_
    ) {
        if (priceDecimals > MAX_PRICE_DECIMALS) revert InvalidConfig();
        if (minPrice == 0 || minPrice > maxPrice || maxPrice > uint256(type(int256).max)) revert InvalidConfig();
        if (readGasStipend < MIN_READ_GAS_STIPEND || readGasStipend > MAX_READ_GAS_STIPEND) revert InvalidConfig();
        MARKET_ID = marketId;
        PRICE_DECIMALS = priceDecimals;
        MIN_PRICE = minPrice;
        MAX_PRICE = maxPrice;
        READ_GAS_STIPEND = readGasStipend;
        SCALE_MUL = priceDecimals < PRICE_DECIMALS_OUT ? uint256(10) ** (PRICE_DECIMALS_OUT - priceDecimals) : 1;
        SCALE_DIV = priceDecimals > PRICE_DECIMALS_OUT ? uint256(10) ** (priceDecimals - PRICE_DECIMALS_OUT) : 1;
        _description = description_;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    /// @notice Raw decoded market info (no type, price or bounds checks). Reverts if the read fails.
    function marketInfo() external view returns (LighterReadCore.MarketInfo memory) {
        return LighterReadCore.readMarket(MARKET_ID, READ_GAS_STIPEND);
    }

    function _price() internal view override returns (uint256 price) {
        LighterReadCore.MarketInfo memory info = LighterReadCore.readMarket(MARKET_ID, READ_GAS_STIPEND);
        if (info.marketType != LighterReadCore.MARKET_TYPE_PERP) revert NotPerpMarket(MARKET_ID, info.marketType);
        if (info.indexPrice == 0) revert ZeroPrice(MARKET_ID);
        // uint64 * 10^8 at most: no overflow. Scaling down rounds toward zero.
        price = (uint256(info.indexPrice) * SCALE_MUL) / SCALE_DIV;
        if (price < MIN_PRICE || price > MAX_PRICE) revert PriceOutOfBounds(MARKET_ID, price, MIN_PRICE, MAX_PRICE);
    }
}
