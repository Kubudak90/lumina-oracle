// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "../utils/Ownable.sol";
import { IAggregator } from "../interfaces/IAggregator.sol";
import { IAdapter } from "../interfaces/IAdapter.sol";
import { IOracle } from "../interfaces/IOracle.sol";
import { IERC4626 } from "../interfaces/IERC4626.sol";
import { IERC20 } from "../interfaces/IERC20.sol";

///@title RatioAdapter
///@author LightLend
///@notice An adapter returning price of some asset with certain ratio to the underlying asset
contract RatioAdapter is Ownable, IAdapter {
    /// @notice contract providing price of the underlying asset
    IOracle public priceProvider;
    /// @notice contract providing the ratio between wrapped and underlying asset
    IOracle public ratioProvider;

    /// @notice the description of the price source
    string public description;
    /// @notice the number of decimals the aggregator responses represent
    uint8 public decimals;
    /// @notice address of the underlying token
    IERC20 public asset;
    ///@notice decimals of the ratio oracle
    uint8 public ratioDecimals;
    ///@notice maximum allowed staleness for price and ratio feeds
    uint256 public immutable MAX_STALENESS;

    /// @param _priceProvider contract providing price of the underlying asset
    /// @param _description the description of the price source
    /// @param _asset address of the underlying asset
    /// @param _ratioProvider contract providing the ratio between wrapped and underlying asset
    /// @param _maxStaleness maximum allowed staleness in seconds
    constructor(address _priceProvider, string memory _description, address _asset, address _ratioProvider, uint256 _maxStaleness) Ownable(msg.sender) {
        priceProvider = IOracle(_priceProvider);
        description = _description;
        decimals = priceProvider.decimals();
        asset = IERC20(_asset);
        ratioProvider = IOracle(_ratioProvider);
        ratioDecimals = ratioProvider.decimals();
        MAX_STALENESS = _maxStaleness;
    }

    /// @notice returns the latest price
    function latestAnswer() external view returns (int256) {
        ( , int256 answer , , , ) = getData();
        return answer;
    }

    /// @notice returns the latest price in chainlink-compatible format
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ){
        return getData();
    }

    function getData() internal view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        (, int256 _answer, , uint256 _updatedAt, ) = priceProvider.latestRoundData();
        require(_answer > 0, "price <= 0");
        require(block.timestamp - _updatedAt < MAX_STALENESS, "price stale");

        (, int256 _ratioAnswer, , uint256 _ratioUpdatedAt, ) = ratioProvider.latestRoundData();
        require(_ratioAnswer > 0, "ratio <= 0");
        require(block.timestamp - _ratioUpdatedAt < MAX_STALENESS, "ratio stale");

        answer = _answer * _ratioAnswer / int256(10**ratioDecimals);
        updatedAt = _updatedAt < _ratioUpdatedAt ? _updatedAt : _ratioUpdatedAt;
        startedAt = updatedAt;
        roundId = 0;
        answeredInRound = 0;
    }
}
