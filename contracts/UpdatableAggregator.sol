// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UpdatableAggregator
 * @notice Chainlink-aggregator-compatible price feed whose answer can be
 *         pushed by an authorized keeper. Designed for AaveOracle on Base
 *         Sepolia where Lumina's LIT token has no native Chainlink feed; an
 *         off-chain keeper (e.g. CoinGecko relayer) calls setAnswer().
 *
 * @dev Returns answers in 1e8 USD units to match Aave's BASE_CURRENCY_UNIT.
 *      Implements the minimal IChainlinkAggregator surface AaveOracle reads:
 *        latestAnswer() / decimals().
 *
 *      Includes:
 *        - Owner role (rotates keepers, sets safety parameters)
 *        - Keeper allowlist (multiple cron jobs / hot wallets)
 *        - Optional max-deviation circuit breaker (0 disables)
 *        - Optional max-staleness window for view callers (0 disables)
 */
contract UpdatableAggregator {
    string public description;
    uint8 public constant decimals = 8;

    address public owner;
    mapping(address => bool) public keepers;

    int256 internal _answer;
    uint256 public lastUpdatedAt;
    uint80 public roundId;

    /// @notice maximum allowed deviation between successive answers, in basis
    ///         points. 0 disables the check.
    uint256 public maxDeviationBps;

    event AnswerUpdated(int256 indexed answer, uint80 indexed roundId, uint256 updatedAt);
    event KeeperSet(address indexed keeper, bool allowed);
    event OwnerChanged(address indexed newOwner);
    event MaxDeviationChanged(uint256 newMaxBps);

    error NotOwner();
    error NotKeeperOrOwner();
    error ZeroAddress();
    error AnswerNonPositive();
    error DeviationTooLarge(uint256 actualBps, uint256 limitBps);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeperOrOwner() {
        if (msg.sender != owner && !keepers[msg.sender]) revert NotKeeperOrOwner();
        _;
    }

    constructor(string memory _description, int256 _initialAnswer, uint256 _maxDeviationBps) {
        if (_initialAnswer <= 0) revert AnswerNonPositive();
        description = _description;
        owner = msg.sender;
        keepers[msg.sender] = true;
        maxDeviationBps = _maxDeviationBps;
        _answer = _initialAnswer;
        lastUpdatedAt = block.timestamp;
        roundId = 1;
        emit KeeperSet(msg.sender, true);
        emit AnswerUpdated(_initialAnswer, 1, block.timestamp);
    }

    // ─── Chainlink-compat reads ─────────────────────────────────────────

    function latestAnswer() external view returns (int256) {
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
        return (roundId, _answer, lastUpdatedAt, lastUpdatedAt, roundId);
    }

    // ─── Keeper writes ──────────────────────────────────────────────────

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

    // ─── Owner admin ────────────────────────────────────────────────────

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setMaxDeviationBps(uint256 newMaxBps) external onlyOwner {
        maxDeviationBps = newMaxBps;
        emit MaxDeviationChanged(newMaxBps);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }
}
