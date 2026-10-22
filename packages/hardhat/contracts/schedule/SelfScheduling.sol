// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IHederaScheduleService } from "../interfaces/IHederaScheduleService.sol";

/// @title SelfScheduling
/// @notice Lets a contract book one future call to itself with the Hedera Schedule Service
/// (HIP-1215), so the network runs it with no keeper bot.
/// @dev At most one call is pending at a time. A target beyond the network's horizon is reached in
/// hops: the call runs at the horizon and books the next hop. When the chosen second is out of
/// capacity, the next free second is used. The booked function must start with `_takeDue()`, which
/// refuses to run before the booked second: so anyone may trigger it (a fallback if the network's
/// run failed), but nobody can trigger it early or book extra calls that spend the contract's HBAR.
///
/// The contract pays for each scheduled run from its own HBAR balance, so it must hold enough when
/// the call runs (the gas limit times the network gas price, with Hedera charging at least 80% of it).
abstract contract SelfScheduling {
    IHederaScheduleService internal constant HSS = IHederaScheduleService(address(0x16b));
    int64 internal constant SUCCESS = 22;

    /// @notice Longest wait in one booking. Hedera refuses schedules more than
    /// `scheduling.maxExpirationFutureSeconds` ahead (62 days by default); longer waits chain hops.
    uint256 public constant MAX_HOP = 60 days;
    /// @dev How many consecutive seconds to try when the chosen one is out of capacity.
    uint256 internal constant CAPACITY_PROBES = 16;

    /// @notice Gas limit of each scheduled run.
    uint256 public immutable scheduledGas;
    /// @notice Second at which the pending call runs, or 0 when nothing is booked.
    uint256 public pendingExpiry;
    /// @notice Address of the pending schedule, or zero when nothing is booked.
    address public pendingSchedule;

    /// @param schedule The schedule entity's address.
    /// @param expirySecond When the network runs it.
    /// @param target The second the caller asked for; later than `expirySecond` while hopping.
    event CallScheduled(address indexed schedule, uint256 expirySecond, uint256 target);

    error GasOutOfRange(uint256 gas);
    error AlreadyScheduled(address schedule, uint256 expirySecond);
    error NoCapacity(uint256 fromSecond);
    error ScheduleFailed(int64 responseCode);
    error NothingScheduled();
    error NotDue(uint256 expirySecond);

    constructor(uint256 scheduledGas_) {
        if (scheduledGas_ < 100_000 || scheduledGas_ > 15_000_000) revert GasOutOfRange(scheduledGas_);
        scheduledGas = scheduledGas_;
    }

    /// @dev Book `callData` on this contract for `target`, or for the furthest second the network
    /// accepts when `target` is beyond it. A target already past runs at the next second.
    function _book(uint256 target, bytes memory callData) internal returns (uint256 expiry) {
        if (pendingExpiry != 0) revert AlreadyScheduled(pendingSchedule, pendingExpiry);
        uint256 earliest = block.timestamp + 1;
        // Leave room under the horizon to probe forward for capacity.
        uint256 latest = block.timestamp + MAX_HOP - CAPACITY_PROBES;
        expiry = target < earliest
            ? earliest
            : target > latest
                ? latest
                : target;

        uint256 tried;
        while (!HSS.hasScheduleCapacity(expiry, scheduledGas)) {
            if (++tried == CAPACITY_PROBES) revert NoCapacity(expiry - tried + 1);
            expiry += 1;
        }
        (int64 responseCode, address schedule) = HSS.scheduleCall(address(this), expiry, scheduledGas, 0, callData);
        if (responseCode != SUCCESS) revert ScheduleFailed(responseCode);

        pendingExpiry = expiry;
        pendingSchedule = schedule;
        emit CallScheduled(schedule, expiry, target);
    }

    /// @dev Call first in the booked function: refuses to run before the booked second, and clears
    /// the booking so the next one can be made.
    function _takeDue() internal {
        uint256 expiry = pendingExpiry;
        if (expiry == 0) revert NothingScheduled();
        if (block.timestamp < expiry) revert NotDue(expiry);
        pendingExpiry = 0;
        pendingSchedule = address(0);
    }

    /// @dev Drop the pending booking, when the work it would do has been done by hand. Deleting the
    /// schedule is best effort: if the network still runs it, `_takeDue` finds nothing booked and
    /// the run reverts without effect.
    function _cancelPending() internal {
        address schedule = pendingSchedule;
        if (pendingExpiry == 0) return;
        pendingExpiry = 0;
        pendingSchedule = address(0);
        try HSS.deleteSchedule(schedule) returns (int64) {} catch {}
    }
}
