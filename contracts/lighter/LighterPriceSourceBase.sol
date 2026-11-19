// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {AggregatorInterface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorInterface.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title LighterPriceSourceBase
/// @notice Aave `AggregatorInterface` + Chainlink `AggregatorV3Interface` shell around a single
/// 8-decimal USD price computed on every call by `_price()`.
/// @dev WARNING: every timestamp returned here is `block.timestamp`. The price is read live, so
/// there is no "last updated" time and freshness cannot be proven by these functions. On Lighter
/// freshness is enforced by `LuminaPriceGuard`, not by consumers checking `updatedAt`.
/// There is no round history: `getAnswer`, `getTimestamp` and `getRoundData` revert.
abstract contract LighterPriceSourceBase is AggregatorInterface, AggregatorV3Interface {
    uint8 internal constant PRICE_DECIMALS_OUT = 8;

    error NoRoundHistory();

    /// @notice Current price with 8 decimals. Reverts instead of returning a non-positive value.
    function _price() internal view virtual returns (uint256);

    // ---------------------------------------------------------------- AggregatorInterface (Aave)

    /// @notice Current price, 8 decimals. Never 0: every failure reverts (AaveOracle would
    /// otherwise fall back to `address(0)`).
    function latestAnswer() external view override returns (int256) {
        return int256(_price());
    }

    /// @notice Always `block.timestamp` (see contract-level warning).
    function latestTimestamp() external view override returns (uint256) {
        return block.timestamp;
    }

    /// @notice Always `block.timestamp`, used as a synthetic round id.
    function latestRound() external view override returns (uint256) {
        return block.timestamp;
    }

    function getAnswer(uint256) external pure override returns (int256) {
        revert NoRoundHistory();
    }

    function getTimestamp(uint256) external pure override returns (uint256) {
        revert NoRoundHistory();
    }

    // -------------------------------------------------------------- AggregatorV3Interface

    function decimals() external pure override returns (uint8) {
        return PRICE_DECIMALS_OUT;
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert NoRoundHistory();
    }

    /// @notice `roundId = answeredInRound = uint80(block.timestamp)`, `startedAt = updatedAt =
    /// block.timestamp` (see contract-level warning).
    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        roundId = uint80(block.timestamp);
        answer = int256(_price());
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
        answeredInRound = roundId;
    }
}
