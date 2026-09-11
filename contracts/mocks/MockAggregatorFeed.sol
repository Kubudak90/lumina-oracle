// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockAggregatorFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public decimals = 8;
    bool public shouldRevert;

    constructor(int256 _answer, uint256 _updatedAt) {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function setRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function latestAnswer() external view returns (int256) {
        if (shouldRevert) revert("feed revert");
        return answer;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (shouldRevert) revert("feed revert");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockACLManager {
    function isPoolAdmin(address) external pure returns (bool) {
        return true;
    }

    function isEmergencyAdmin(address) external pure returns (bool) {
        return true;
    }

    function isRiskAdmin(address) external pure returns (bool) {
        return true;
    }
}
