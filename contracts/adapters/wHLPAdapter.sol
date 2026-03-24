// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "../utils/Ownable.sol";
import { IAggregator } from "../interfaces/IAggregator.sol";
import { IAdapter } from "../interfaces/IAdapter.sol";
import { IOracle } from "../interfaces/IOracle.sol";
import { IERC4626 } from "../interfaces/IERC4626.sol";

interface IAccountant {
    function getRateSafe() external view returns (uint256 rate);
    function decimals() external view returns (uint8);
    function getRateInQuoteSafe(address quote) external view returns (uint256);
}

contract wHlpAdapter {
    /// @notice contract providing price of the quote asset
    IOracle public priceProvider;
    /// @notice wHLP accountant contract
    IAccountant public accountant;

    /// @notice address of the quote asset (USDhl)
    address public quoteAsset;
    /// @notice decimals of the wHLP/USDhl ratio
    uint256 public ratioDecimals;
    ///@notice maximum allowed staleness for price feed
    uint256 public immutable MAX_STALENESS;

    /// @param _priceProvider contract providing price of the quote asset
    /// @param _accountant wHLP accountant contract
    /// @param _quoteAsset address of the quote asset (USDhl)
    /// @param _maxStaleness maximum allowed staleness in seconds
    constructor(address _priceProvider, address _accountant, address _quoteAsset, uint256 _maxStaleness) {
        priceProvider = IOracle(_priceProvider);
        accountant = IAccountant(_accountant);
        quoteAsset = _quoteAsset;
        ratioDecimals = accountant.decimals();
        MAX_STALENESS = _maxStaleness;
    }

    function decimals() external view returns (uint8){
        return 8;
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

    /// @notice calculate the final price from USDHL/USD price and wHLP/USDHL ratio
    function getData() internal view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        //fetch quote asset price (USDhl)
        (
            uint80 _roundId,
            int256 _answer,
            uint256 _startedAt,
            uint256 _updatedAt,
            uint80 _answeredInRound
        ) = priceProvider.latestRoundData();
        require(_answer > 0, "price <= 0");
        require(block.timestamp - _updatedAt < MAX_STALENESS, "price stale");

        //get the wHLP/USDhl ratio
        uint256 _ratioAnswer = accountant.getRateInQuoteSafe(quoteAsset);
        require(_ratioAnswer > 0, "ratio <= 0");

        answer = _answer * int256(_ratioAnswer) / int256(10**ratioDecimals);

        //return round data for the underlying price
        roundId = _roundId;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
        answeredInRound = _answeredInRound;
    }
}
