// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "../utils/Ownable.sol";
import { IAggregator } from "../interfaces/IAggregator.sol";
import { IAdapter } from "../interfaces/IAdapter.sol";

///@title AssetOracleAdapter
///@author fbsloXBT
///@notice An oracle proxy exposing price for a certain asset
contract AssetOracleAdapter is Ownable, IAdapter {
    /// @notice aggregator contract collecting price data from different sources
    IAggregator public aggregator;

    /// @notice the description of the price source
    string public description;
    /// @notice the number of decimals the aggregator responses represent
    uint8 public decimals;
    /// @notice address of the underlying asset
    address public asset;

    /// @param _aggregator aggregator contract collecting price data from different sources
    /// @param _description the description of the price source
    /// @param _decimals the number of decimals the aggregator responses represent
    /// @param _asset address of the underlying asset
    constructor(address _aggregator, string memory _description, uint8 _decimals, address _asset) Ownable(msg.sender) {
        aggregator = IAggregator(_aggregator);
        description = _description;
        decimals = _decimals;
        asset = _asset;
    }

    /// @notice returns the latest price from the aggregator
    function latestAnswer() public view returns (int256) {
        uint256 price = aggregator.getPrice(asset);
        require(price > 0, "invalid price");
        return int256(price);
    }

    /// @notice returns the latest price in chainlink-compatible format
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ){
        int256 price = latestAnswer();
        require(price > 0, "invalid price");
        uint256 lastUpdate = aggregator.getUpdateTimestamp(asset);
        return (0, price, lastUpdate, lastUpdate, 0);
    }
}
