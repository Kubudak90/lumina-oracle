// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPyth, PythStructs} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

///@title PythOracleAdapter
///@author fbsloXBT
///@notice Pyth oracle adapter with staleness protection
contract PythOracleAdapter {
    /// @notice pyth oracle contract on the LighterEVM chain
    IPyth public immutable pyth;
    /// @notice Pyth price feed ID for this asset
    bytes32 public immutable priceFeedId;
    /// @notice maximum allowed staleness in seconds
    uint256 public immutable MAX_STALENESS;

    /// @param _pyth The address of the Pyth contract
    /// @param _priceFeedId ID of the Pyth price feed
    /// @param _maxStaleness maximum allowed staleness in seconds
    constructor(address _pyth, bytes32 _priceFeedId, uint256 _maxStaleness) {
        pyth = IPyth(_pyth);
        priceFeedId = _priceFeedId;
        MAX_STALENESS = _maxStaleness;
    }

    function _getPrice() internal view returns (PythStructs.Price memory price) {
        price = pyth.getPriceNoOlderThan(priceFeedId, MAX_STALENESS);
        require(price.price > 0, "invalid price");
        require(price.expo <= 0, "unexpected positive exponent");
    }

    function latestAnswer() external view returns (int256) {
        PythStructs.Price memory price = _getPrice();
        return int256(price.price);
    }

    function decimals() external view returns (uint8) {
        PythStructs.Price memory price = _getPrice();
        return uint8(uint32(-1 * price.expo));
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        PythStructs.Price memory price = _getPrice();
        return (
            0,
            int256(price.price),
            price.publishTime,
            price.publishTime,
            0
        );
    }

    function getRoundData(uint80) external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return this.latestRoundData();
    }

    function latestTimestamp() external view returns (uint256) {
        PythStructs.Price memory price = _getPrice();
        return price.publishTime;
    }
}
