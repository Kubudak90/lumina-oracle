// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "../utils/Ownable.sol";
import { IAggregator } from "../interfaces/IAggregator.sol";
import { IAdapter } from "../interfaces/IAdapter.sol";
import { IOracle } from "../interfaces/IOracle.sol";
import { IERC4626 } from "../interfaces/IERC4626.sol";

interface IkmLIT {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function balanceToShareDecimals() external view returns (uint256);
    function sharesToBalance(uint256) external view returns (uint256);
    function balancePerShare() external view returns (uint256);
    function sthype() external view returns (address);
}

interface IManager {
    function EXLSTToLIT(uint256 shares) external view returns (uint256);
}

///@title kmLitAdapterFundamental
///@author LightLend
///@notice An adapter returning price of kmLIT, based on underlying asset
contract kmLitAdapterFundamental is Ownable, IAdapter {
    /// @notice contract providing price of the underlying asset
    IOracle public priceProvider;

    /// @notice the description of the price source
    string public description;
    /// @notice the number of decimals the aggregator responses represent
    uint8 public decimals;
    /// @notice address of the underlying kmLIT token
    IkmLIT public asset;
    /// @notice address of the EX Manager
    IManager public manager;
    ///@notice decimals of the ratio oracle
    uint8 public ratioDecimals;
    ///@notice maximum allowed staleness for price feed
    uint256 public immutable MAX_STALENESS;

    /// @param _priceProvider contract providing price of the underlying asset
    /// @param _description the description of the price source
    /// @param _asset address of the underlying asset
    /// @param _ratioDecimals number of decimal places for kmLIT/LIT ratio
    /// @param _manager address of the EX Manager
    /// @param _maxStaleness maximum allowed staleness in seconds
    constructor(address _priceProvider, string memory _description, address _asset, uint8 _ratioDecimals, address _manager, uint256 _maxStaleness) Ownable(msg.sender) {
        priceProvider = IOracle(_priceProvider);
        description = _description;
        decimals = priceProvider.decimals();
        asset = IkmLIT(_asset);
        ratioDecimals = _ratioDecimals;
        manager = IManager(_manager);
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
        (
            uint80 _roundId,
            int256 _answer,
            uint256 _startedAt,
            uint256 _updatedAt,
            uint80 _answeredInRound
        ) = priceProvider.latestRoundData();
        require(_answer > 0, "price <= 0");
        require(block.timestamp - _updatedAt < MAX_STALENESS, "price stale");

        //get the kmLIT/LIT ratio with 18 decimals
        int256 _ratioAnswer = getRatio();

        answer = _answer * _ratioAnswer / int256(10**ratioDecimals);

        //return round data for the underlying price
        roundId = _roundId;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
        answeredInRound = _answeredInRound;
    }

    function getRatio() public view returns (int256) {
        uint256 ratio = manager.EXLSTToLIT(1_000_000_000_000_000_000);
        require(ratio > 0, "ratio is 0");
        require(ratio <= 2e18, "ratio too high");
        return int256(ratio);
    }
}
