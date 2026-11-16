// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SelfScheduling } from "./schedule/SelfScheduling.sol";

/// @title VestingSchedule
/// @notice Pays one token to a fixed beneficiary in equal tranches, and the Hedera network runs
/// each payment itself: every payment books the next one with the Schedule Service (HIP-1215), so
/// no keeper bot or server is involved. LaunchBlocks vests a team or treasury allocation with it.
/// @dev No owner, nothing changes after deployment. A tranche's size is decided when it is paid:
/// what the contract holds, divided by the tranches still to pay, so the last one pays the rest
/// and later deposits spread over the remaining tranches. When a run comes late, it pays every
/// tranche due by then. Anyone may trigger a due payment with `release`, as a fallback.
///
/// The contract pays for each scheduled run from its HBAR balance: fund it when arming. After the
/// last tranche, the HBAR left goes back to `refundTo`. On Hedera, `token` is an HTS token through
/// its ERC-20 facade, and the contract needs a free automatic association slot to receive it.
contract VestingSchedule is SelfScheduling {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TRANCHES = 120;
    uint256 public constant MIN_INTERVAL = 60;

    IERC20 public immutable token;
    address public immutable beneficiary;
    /// @notice Unix time of the first tranche.
    uint256 public immutable start;
    /// @notice Seconds between tranches.
    uint256 public immutable interval;
    uint256 public immutable tranches;
    address payable public immutable refundTo;
    /// @notice How many tranches have been paid.
    uint256 public paid;

    /// @param fromTranche First tranche covered by this payment (0-based).
    /// @param toTranche One past the last tranche covered.
    event TranchesPaid(uint256 fromTranche, uint256 toTranche, uint256 amount);
    event Refunded(address indexed to, uint256 amount);

    error ZeroAddress();
    error BeneficiaryIsVesting();
    error BadSchedule();
    error NothingDue(uint256 nextReleaseTime);
    error Finished();

    /// @param token_ The token to vest.
    /// @param beneficiary_ Who receives the tranches.
    /// @param startDelay Seconds from deployment to the first tranche.
    /// @param interval_ Seconds between tranches, at least a minute.
    /// @param tranches_ Number of tranches, 1 to 120.
    /// @param refundTo_ Who gets back the unspent HBAR after the last tranche.
    /// @param scheduledGas_ Gas limit of each scheduled run.
    constructor(
        address token_,
        address beneficiary_,
        uint256 startDelay,
        uint256 interval_,
        uint256 tranches_,
        address payable refundTo_,
        uint256 scheduledGas_
    ) payable SelfScheduling(scheduledGas_) {
        if (token_ == address(0) || beneficiary_ == address(0) || refundTo_ == address(0)) revert ZeroAddress();
        if (beneficiary_ == address(this)) revert BeneficiaryIsVesting();
        if (tranches_ == 0 || tranches_ > MAX_TRANCHES || interval_ < MIN_INTERVAL) revert BadSchedule();
        token = IERC20(token_);
        beneficiary = beneficiary_;
        start = block.timestamp + startDelay;
        interval = interval_;
        tranches = tranches_;
        refundTo = refundTo_;
    }

    /// @notice HBAR sent here pays for the scheduled runs.
    receive() external payable {}

    /// @notice How many tranches are due by now, paid or not.
    function tranchesDue() public view returns (uint256) {
        if (block.timestamp < start) return 0;
        uint256 due = 1 + (block.timestamp - start) / interval;
        return due > tranches ? tranches : due;
    }

    /// @notice When the next unpaid tranche is due.
    function nextReleaseTime() public view returns (uint256) {
        return start + paid * interval;
    }

    /// @notice What the contract still holds for the beneficiary.
    function remaining() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Book the network's next payment (or a hop toward it). Anyone may arm the schedule and
    /// send HBAR for the runs with it.
    function arm() external payable {
        if (paid == tranches) revert Finished();
        _book(nextReleaseTime(), abi.encodeCall(this.onSchedule, ()));
    }

    /// @notice The call the network runs: pays what is due and books the next payment.
    /// Anyone may call it once its booked second has passed.
    function onSchedule() external {
        _takeDue();
        _settle();
    }

    /// @notice Pay the tranches due now, when the network's run did not happen. A booking whose
    /// second has passed is cancelled and replaced; a future one is kept.
    function release() external {
        if (tranchesDue() <= paid) revert NothingDue(nextReleaseTime());
        if (pendingExpiry != 0 && block.timestamp >= pendingExpiry) _cancelPending();
        _settle();
    }

    function _settle() private {
        uint256 due = tranchesDue();
        if (due > paid) {
            uint256 amount = (token.balanceOf(address(this)) * (due - paid)) / (tranches - paid);
            uint256 from = paid;
            paid = due;
            emit TranchesPaid(from, due, amount);
            if (amount != 0) token.safeTransfer(beneficiary, amount);
        }
        if (paid == tranches) {
            _cancelPending();
            _refund();
        } else if (pendingExpiry == 0) {
            _book(nextReleaseTime(), abi.encodeCall(this.onSchedule, ()));
        }
    }

    function _refund() private {
        uint256 hbar = address(this).balance;
        if (hbar == 0) return;
        (bool sent, ) = refundTo.call{ value: hbar }("");
        if (sent) emit Refunded(refundTo, hbar);
    }
}
