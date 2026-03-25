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

    uint256 public constant CUSTOM_PRICE_VALIDITY_BLOCKS = 500;
    uint256 public constant MAX_DEVIATION_BPS = 1000; // 10% max deviation from source

    /// @notice Block number of last price change
    uint256 public lastPriceChangeBlock;
    /// @notice Minimum blocks between price changes
    uint256 public constant MIN_PRICE_CHANGE_INTERVAL = 100;

    event CustomPriceSet(int256 price, uint256 blockNumber);

    /// @notice Pending owner for two-step transfer
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Initiate ownership transfer
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "zero address");
        pendingOwner = _newOwner;
        emit OwnershipTransferStarted(owner, _newOwner);
    }

    /// @notice Accept pending ownership
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

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
        require(block.number - lastPriceChangeBlock >= MIN_PRICE_CHANGE_INTERVAL, "price changes too frequent");

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
        lastPriceChangeBlock = block.number;
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
