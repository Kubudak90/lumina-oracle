// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title LighterReadCore
/// @notice Reads Lighter Core market info through the `READ_CORE` precompile.
/// @dev Precompile facts (docs.lighter.xyz, 2026-11-19):
///  - address `0x6600…0000`, called with `staticcall`;
///  - market info: input `abi.encodePacked(uint16(0x0005), uint16 marketId)` (4 bytes), output
///    `abi.encode(uint8 marketType, uint32 baseAssetId, uint32 quoteAssetId, uint32 takerFee,
///    uint32 makerFee, uint64 minBaseAmount, uint64 minQuoteAmount, uint32 liquidationFee,
///    uint64 indexPrice, uint64 markPrice)` (320 bytes);
///  - a failed read consumes all forwarded gas, so every read forwards a fixed stipend;
///  - reads see a per-block pinned Core snapshot that may lag; no timestamp is exposed.
library LighterReadCore {
    address internal constant READ_CORE = 0x6600000000000000000000000000000000000000;
    uint16 internal constant SELECTOR_MARKET_INFO = 0x0005;
    uint256 internal constant MARKET_INFO_LENGTH = 320;
    uint8 internal constant MARKET_TYPE_PERP = 0;

    struct MarketInfo {
        uint8 marketType;
        uint32 baseAssetId;
        uint32 quoteAssetId;
        uint32 takerFee;
        uint32 makerFee;
        uint64 minBaseAmount;
        uint64 minQuoteAmount;
        uint32 liquidationFee;
        uint64 indexPrice;
        uint64 markPrice;
    }

    error ReadCoreFailed(uint16 marketId);
    error ReadCoreBadLength(uint16 marketId, uint256 length);

    /// @notice Reads market info, forwarding at most `gasStipend` gas to the precompile.
    /// @dev Reverts on a failed read or a response that is not exactly 320 bytes. `abi.decode`
    /// additionally reverts if a word does not fit its declared type.
    function readMarket(uint16 marketId, uint256 gasStipend) internal view returns (MarketInfo memory info) {
        (bool ok, bytes memory ret) =
            READ_CORE.staticcall{gas: gasStipend}(abi.encodePacked(SELECTOR_MARKET_INFO, marketId));
        if (!ok) revert ReadCoreFailed(marketId);
        if (ret.length != MARKET_INFO_LENGTH) revert ReadCoreBadLength(marketId, ret.length);
        info = abi.decode(ret, (MarketInfo));
    }
}
