// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IAdapter.sol";

interface IChainlinkLike {
    function latestAnswer() external view returns (int256);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

///@title CustomizableOracle
///@author LightLend
///@notice An oracle where owner can set the price for some time
contract CustomizableOracle {
    address public owner;
    IChainlinkLike public source;

    int256 public customPrice;
    uint256 public customPriceBlock;

    uint256 public constant CUSTOM_PRICE_VALIDITY_BLOCKS = 1000;
    uint256 public constant MAX_DEVIATION_BPS = 1000; // 10% max deviation from source

    event CustomPriceSet(int256 price, uint256 blockNumber);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _source) {
        owner = msg.sender;
        source = IChainlinkLike(_source);
    }

    function setPrice(int256 _price) external onlyOwner {
        require(_price > 0, "price must be > 0");

        // Deviation check against source
        int256 sourcePrice = source.latestAnswer();
        if (sourcePrice > 0) {
            uint256 deviation;
            if (_price > sourcePrice) {
                deviation = uint256(_price - sourcePrice) * 10000 / uint256(sourcePrice);
            } else {
                deviation = uint256(sourcePrice - _price) * 10000 / uint256(sourcePrice);
            }
            require(deviation <= MAX_DEVIATION_BPS, "deviation too large");
        }

        customPrice = _price;
        customPriceBlock = block.number;
        emit CustomPriceSet(_price, block.number);
    }

    function _isCustomPriceActive() internal view returns (bool) {
        return customPrice > 0 && block.number - customPriceBlock < CUSTOM_PRICE_VALIDITY_BLOCKS;
    }

    /// @notice returns the latest price from the aggregator
    function latestAnswer() public view returns (int256) {
        if (_isCustomPriceActive()) {
            return customPrice;
        }
        return source.latestAnswer();
    }

    /// @notice returns the number of decimals (always 8)
    function decimals() external pure returns (uint8) {
        return 8;
    }

    /// @notice returns a human-readable description
    function description() external pure returns (string memory) {
        return "CustomizableOracle";
    }

    /// @notice returns the latest price in chainlink-compatible format
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ){
        if (_isCustomPriceActive()) {
            return (0, customPrice, block.timestamp, block.timestamp, 0);
        }
        return source.latestRoundData();
    }
}
