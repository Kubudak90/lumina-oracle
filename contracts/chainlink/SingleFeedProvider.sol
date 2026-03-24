// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ChainlinkConsumer} from "./ChainlinkConsumer.sol";

/// @title SingleFeedProvider
/// @author LightLend
/// @notice Contract serving data for a single price feed
contract SingleFeedProvider {
    /// @notice ChainlinkConsumer source contract
    ChainlinkConsumer public source;
    /// @notice feedId of the target price feed
    bytes32 public feedId;
    /// @notice number of decimals from the DON report
    uint256 public donDecimals;
    /// @notice description of the price feed
    string public description;
    /// @notice maximum allowed staleness in seconds
    uint256 public immutable MAX_STALENESS;

    /// @param _source address of the ChainlinkConsumer that verifies and holds actual data
    /// @param _feedId id of the target price feed
    /// @param _donDecimals number of decimals from the DON report
    /// @param _description description of the price feed
    /// @param _maxStaleness maximum allowed staleness in seconds
    constructor(address _source, bytes32 _feedId, uint256 _donDecimals, string memory _description, uint256 _maxStaleness){
        require(_donDecimals >= decimals(), "donDecimals < decimals");

        source = ChainlinkConsumer(_source);
        feedId = _feedId;
        donDecimals = _donDecimals;
        description = _description;
        MAX_STALENESS = _maxStaleness;
    }

    /// @notice returns the number of decimals for the price format
    /// @dev always returns 8
    function decimals() public view virtual returns (uint8) {
        return 8;
    }

    /// @notice returns the latest DON consensus median benchmark price that was verified on ChainlinkConsumer
    function latestAnswer() public view virtual returns (int256) {
        uint256 timestamp = source.getLatestTimestamp(feedId);
        require(timestamp > 0, "not initialized");
        require(block.timestamp - timestamp < MAX_STALENESS, "stale");

        int256 price = source.getLatestAnswer(feedId) / int256(10 ** (donDecimals - decimals())); //since the DON could report data with 18 decimals and our contracts use 8, we must divide
        require(price > 0, "invalid price");
        return price;
    }

    /// @notice returns the latest timestamp
    /// @dev timestamp is average between `validFromTimestamp` and `observationsTimestamp` from DON report
    function latestTimestamp() public view returns (uint256) {
        return source.getLatestTimestamp(feedId);
    }

    /// @notice returns the latest price
    /// @dev param is ignored because historical data is not stored or used in our contracts
    function getAnswer(uint256) public view returns (int256) {
        return latestAnswer();
    }

    /// @notice returns the latest timestamp
    /// @dev param is ignored, since we don't store historical data for past rounds, since it's not used in our other contracts
    function getTimestamp(uint256) external view returns (uint256) {
        return latestTimestamp();
    }

    /// @notice returns the latest data, using timestamp as roundId
    /// @dev all fields use the same timestamp as historical rounds are not tracked
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        uint256 _timestamp = latestTimestamp();
        require(_timestamp > 0, "not initialized");
        require(block.timestamp - _timestamp < MAX_STALENESS, "stale");

        int256 _answer = source.getLatestAnswer(feedId) / int256(10 ** (donDecimals - decimals()));
        require(_answer > 0, "invalid price");

        roundId = uint80(_timestamp);
        answer = _answer;
        startedAt = _timestamp;
        updatedAt = _timestamp;
        answeredInRound = uint80(_timestamp);
    }
}
