// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SelfScheduling } from "./schedule/SelfScheduling.sol";

/// @title SelfReleasingLock
/// @notice Holds one token until a release time, then the Hedera network itself pays everything
/// it holds to a fixed beneficiary: `arm` books the release with the Schedule Service (HIP-1215),
/// so no keeper bot or server has to call it. LaunchBlocks locks a SaucerSwap pool's LP tokens in it.
/// @dev Same trust model as `TokenLock`: no owner, nothing changes after deployment, and the tokens
/// only ever go to `beneficiary`. `release` stays callable by anyone once due, as a fallback.
///
/// The lock pays for each scheduled run from its HBAR balance: fund it when arming (a few HBAR is
/// plenty; see `SelfScheduling`). A lock longer than `MAX_HOP` hops at the horizon, one paid run
/// per hop. After the release, the HBAR left goes back to `refundTo`.
///
/// On Hedera, `token` is an HTS token through its ERC-20 facade, and the lock needs a free
/// automatic association slot to receive it.
contract SelfReleasingLock is SelfScheduling {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    /// @notice Unix time, in seconds, from which the tokens are paid out.
    uint256 public immutable releaseTime;
    /// @notice Who gets back the HBAR left after the release.
    address payable public immutable refundTo;

    event Released(address indexed beneficiary, uint256 amount);
    event Refunded(address indexed to, uint256 amount);

    error ZeroAddress();
    error BeneficiaryIsLock();
    error StillLocked(uint256 releaseTime);
    error NothingToRelease();
    error StillHolding();

    /// @param token_ The token to hold.
    /// @param beneficiary_ Who receives the tokens on release.
    /// @param lockSeconds How long from deployment the tokens stay locked.
    /// @param refundTo_ Who gets back the unspent HBAR after the release.
    /// @param scheduledGas_ Gas limit of each scheduled run.
    constructor(
        address token_,
        address beneficiary_,
        uint256 lockSeconds,
        address payable refundTo_,
        uint256 scheduledGas_
    ) payable SelfScheduling(scheduledGas_) {
        if (token_ == address(0) || beneficiary_ == address(0) || refundTo_ == address(0)) revert ZeroAddress();
        if (beneficiary_ == address(this)) revert BeneficiaryIsLock();
        token = IERC20(token_);
        beneficiary = beneficiary_;
        releaseTime = block.timestamp + lockSeconds;
        refundTo = refundTo_;
    }

    /// @notice HBAR sent here pays for the scheduled runs.
    receive() external payable {}

    /// @notice How many token units the lock holds right now.
    function lockedAmount() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Book the network's release (or, for a long lock, its first hop). Anyone may arm the
    /// lock and send HBAR for the runs with it; nothing else changes.
    function arm() external payable {
        _book(releaseTime, abi.encodeCall(this.onSchedule, ()));
    }

    /// @notice The call the network runs: releases when due, otherwise books the next hop.
    /// Anyone may call it once its booked second has passed.
    function onSchedule() external {
        _takeDue();
        if (block.timestamp < releaseTime) {
            _book(releaseTime, abi.encodeCall(this.onSchedule, ()));
            return;
        }
        _payOut();
    }

    /// @notice Pay everything the lock holds to the beneficiary once the release time has come.
    /// The network does this on its own after `arm`; this is the manual fallback, and it cancels
    /// the network's pending run.
    /// @return amount The token units paid out.
    function release() external returns (uint256 amount) {
        if (block.timestamp < releaseTime) revert StillLocked(releaseTime);
        if (token.balanceOf(address(this)) == 0) revert NothingToRelease();
        _cancelPending();
        return _payOut();
    }

    /// @notice Send the HBAR left to `refundTo` once the tokens are out, cancelling any pending run.
    /// While the lock still holds tokens it refuses, so nobody can cancel the network's release.
    function refund() external {
        if (block.timestamp < releaseTime) revert StillLocked(releaseTime);
        if (token.balanceOf(address(this)) != 0) revert StillHolding();
        _cancelPending();
        _refund();
    }

    function _payOut() private returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount != 0) {
            emit Released(beneficiary, amount);
            token.safeTransfer(beneficiary, amount);
        }
        _refund();
    }

    function _refund() private {
        uint256 hbar = address(this).balance;
        if (hbar == 0) return;
        // A refund address that refuses HBAR must not block the release; `refund` can retry.
        (bool sent, ) = refundTo.call{ value: hbar }("");
        if (sent) emit Refunded(refundTo, hbar);
    }
}
