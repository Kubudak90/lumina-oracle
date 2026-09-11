// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UpdatableAggregator
 * @notice Chainlink-aggregator-compatible price feed whose answer can be
 *         pushed by an authorized keeper. Designed for AaveOracle on Base
 *         Sepolia where Lumina's LIT token has no native Chainlink feed.
 *
 * @dev Returns answers in 1e8 USD units to match Aave's BASE_CURRENCY_UNIT.
 *      AaveOracle reads latestAnswer() / latestRoundData() / decimals().
 *      Those views revert when the feed is uninitialized, from the future, or
 *      older than maxStaleness. maxStaleness cannot be disabled.
 */
contract UpdatableAggregator {
    string public description;
    uint8 public constant decimals = 8;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public keepers;

    int256 internal _answer;
    uint256 public lastUpdatedAt;
    uint80 public roundId;

    /// @notice maximum allowed deviation between successive keeper answers, in
    ///         basis points. 0 disables the keeper-path check. Cannot exceed 10_000.
    uint256 public maxDeviationBps;

    /// @notice maximum allowed age of latestAnswer / latestRoundData, in seconds.
    ///         Must be > 0. Age == maxStaleness is still fresh; age == maxStaleness + 1 reverts.
    uint256 public maxStaleness;

    event AnswerUpdated(int256 indexed answer, uint80 indexed roundId, uint256 updatedAt);
    event EmergencyAnswerUpdated(
        int256 indexed oldAnswer,
        int256 indexed newAnswer,
        uint80 indexed roundId,
        uint256 updatedAt,
        string reason
    );
    event KeeperSet(address indexed keeper, bool allowed);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event MaxDeviationChanged(uint256 newMaxBps);
    event MaxStalenessChanged(uint256 newMaxStaleness);

    error NotOwner();
    error NotPendingOwner();
    error NotKeeperOrOwner();
    error ZeroAddress();
    error AnswerNonPositive();
    error DeviationTooLarge(uint256 actualBps, uint256 limitBps);
    error InvalidMaxDeviation();
    error InvalidMaxStaleness();
    error PriceUninitialized();
    error PriceFromFuture();
    error PriceStale(uint256 updatedAt, uint256 maxStaleness_);
    error EmptyReason();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeperOrOwner() {
        if (msg.sender != owner && !keepers[msg.sender]) revert NotKeeperOrOwner();
        _;
    }

    constructor(
        string memory _description,
        int256 _initialAnswer,
        uint256 _maxDeviationBps,
        uint256 _maxStaleness
    ) {
        if (_initialAnswer <= 0) revert AnswerNonPositive();
        if (_maxDeviationBps > 10_000) revert InvalidMaxDeviation();
        if (_maxStaleness == 0) revert InvalidMaxStaleness();
        description = _description;
        owner = msg.sender;
        keepers[msg.sender] = true;
        maxDeviationBps = _maxDeviationBps;
        maxStaleness = _maxStaleness;
        _answer = _initialAnswer;
        lastUpdatedAt = block.timestamp;
        roundId = 1;
        emit KeeperSet(msg.sender, true);
        emit AnswerUpdated(_initialAnswer, 1, block.timestamp);
    }

    function latestAnswer() external view returns (int256) {
        _requireFresh();
        return _answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return lastUpdatedAt;
    }

    function latestRound() external view returns (uint80) {
        return roundId;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        _requireFresh();
        return (roundId, _answer, lastUpdatedAt, lastUpdatedAt, roundId);
    }

    /// @notice Push a new answer. Reverts on non-positive or large deviations.
    function setAnswer(int256 newAnswer) external onlyKeeperOrOwner {
        if (newAnswer <= 0) revert AnswerNonPositive();
        if (maxDeviationBps != 0) {
            uint256 prev = uint256(_answer);
            uint256 next = uint256(newAnswer);
            uint256 diff = next > prev ? next - prev : prev - next;
            uint256 dev = (diff * 10_000) / prev;
            if (dev > maxDeviationBps) revert DeviationTooLarge(dev, maxDeviationBps);
        }
        _answer = newAnswer;
        lastUpdatedAt = block.timestamp;
        unchecked { roundId += 1; }
        emit AnswerUpdated(newAnswer, roundId, block.timestamp);
    }

    /// @notice Owner/timelock recovery that bypasses the deviation circuit breaker.
    /// @dev Does not disable deviation protection for subsequent keeper updates.
    function emergencySetAnswer(int256 newAnswer, string calldata reason) external onlyOwner {
        if (newAnswer <= 0) revert AnswerNonPositive();
        if (bytes(reason).length == 0) revert EmptyReason();
        int256 oldAnswer = _answer;
        _answer = newAnswer;
        lastUpdatedAt = block.timestamp;
        unchecked { roundId += 1; }
        emit EmergencyAnswerUpdated(oldAnswer, newAnswer, roundId, block.timestamp, reason);
        emit AnswerUpdated(newAnswer, roundId, block.timestamp);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setMaxDeviationBps(uint256 newMaxBps) external onlyOwner {
        if (newMaxBps > 10_000) revert InvalidMaxDeviation();
        maxDeviationBps = newMaxBps;
        emit MaxDeviationChanged(newMaxBps);
    }

    function setMaxStaleness(uint256 newMaxStaleness) external onlyOwner {
        if (newMaxStaleness == 0) revert InvalidMaxStaleness();
        maxStaleness = newMaxStaleness;
        emit MaxStalenessChanged(newMaxStaleness);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        keepers[owner] = true;
        emit KeeperSet(owner, true);
        emit OwnerChanged(previous, owner);
    }

    function _requireFresh() internal view {
        if (lastUpdatedAt == 0) revert PriceUninitialized();
        if (lastUpdatedAt > block.timestamp) revert PriceFromFuture();
        if (block.timestamp - lastUpdatedAt > maxStaleness) {
            revert PriceStale(lastUpdatedAt, maxStaleness);
        }
    }
}
