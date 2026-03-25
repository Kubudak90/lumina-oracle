// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "../utils/Ownable.sol";
import { IAggregator } from "../interfaces/IAggregator.sol";
import { IAdapter } from "../interfaces/IAdapter.sol";
import { IOracle } from "../interfaces/IOracle.sol";
import { IERC4626 } from "../interfaces/IERC4626.sol";

///@title ERC4626Adapter
///@author fbsloXBT
///@notice An adapter returning price of ERC4626 vault share, based on underlying asset price & share value
contract ERC4626Adapter is Ownable, IAdapter {
    /// @notice contract providing price of the underlying asset
    IOracle public priceProvider;

    /// @notice the description of the price source
    string public description;
    /// @notice the number of decimals the aggregator responses represent
    uint8 public decimals;
    /// @notice address of the underlying IERC4626-compatible asset
    IERC4626 public asset;
    ///@notice maximum allowed staleness for price feed
    uint256 public immutable MAX_STALENESS;

    /// @param _priceProvider contract providing price of the underlying asset
    /// @param _description the description of the price source
    /// @param _asset address of the underlying asset
    /// @param _maxStaleness maximum allowed staleness in seconds
    constructor(address _priceProvider, string memory _description, address _asset, uint256 _maxStaleness) Ownable(msg.sender) {
        priceProvider = IOracle(_priceProvider);
        description = _description;
        decimals = priceProvider.decimals();
        asset = IERC4626(_asset);
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

        //get assets per 1 vault token (accounting for decimals)
        uint256 baseShareAmount = 10 ** asset.decimals();
        uint256 assetPerBaseShare = asset.convertToAssets(baseShareAmount);

        require(assetPerBaseShare > 0, "ratio is 0");
        // Sanity: ratio should not be more than 3x base (protection against donation attacks)
        require(assetPerBaseShare <= baseShareAmount * 3, "ratio too high");
        require(asset.totalSupply() >= 1e6, "vault too small");

        //calculate the price of 1 vault token
        answer = _answer * int256(assetPerBaseShare) / int256(baseShareAmount);

        roundId = _roundId;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
        answeredInRound = _answeredInRound;
    }
}
