// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MockHederaScheduleService
/// @notice Test double for the Hedera Schedule Service (HIP-1215). Tests install its runtime code
/// at 0x16b with `hardhat_setCode`; it records each booked call, can mark seconds as out of
/// capacity or fail the next booking, and `fire` runs a call the way the network would once its
/// second has come. Not for deployment.
contract MockHederaScheduleService {
    int64 internal constant SUCCESS = 22;
    int64 internal constant TOO_FAR = 306;
    int64 internal constant NOT_IN_FUTURE = 307;
    int64 internal constant BUSY = 370;
    uint256 internal constant MAX_FUTURE = 62 days;

    struct ScheduledCall {
        address to;
        address payer;
        uint256 expirySecond;
        uint256 gasLimit;
        uint64 value;
        bytes callData;
        bool ran;
        bool deleted;
    }

    ScheduledCall[] internal calls;
    mapping(uint256 => bool) public busy;
    int64 public failNextWith;

    event Fired(uint256 indexed index, bool success, bytes returnData);

    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64 responseCode, address scheduleAddress) {
        if (failNextWith != 0) {
            responseCode = failNextWith;
            failNextWith = 0;
            return (responseCode, address(0));
        }
        if (expirySecond <= block.timestamp) return (NOT_IN_FUTURE, address(0));
        if (expirySecond > block.timestamp + MAX_FUTURE) return (TOO_FAR, address(0));
        if (busy[expirySecond]) return (BUSY, address(0));
        calls.push(ScheduledCall(to, msg.sender, expirySecond, gasLimit, value, callData, false, false));
        return (SUCCESS, scheduleAddressOf(calls.length - 1));
    }

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode) {
        uint256 index = uint160(scheduleAddress) - 0x5c00;
        calls[index].deleted = true;
        return SUCCESS;
    }

    function hasScheduleCapacity(uint256 expirySecond, uint256) external view returns (bool hasCapacity) {
        return !busy[expirySecond];
    }

    // ---- test controls ----

    function setBusy(uint256 second, bool isBusy) external {
        busy[second] = isBusy;
    }

    function failNext(int64 responseCode) external {
        failNextWith = responseCode;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function callAt(uint256 index) external view returns (ScheduledCall memory) {
        return calls[index];
    }

    function scheduleAddressOf(uint256 index) public pure returns (address) {
        return address(uint160(0x5c00 + index));
    }

    /// @notice Run a booked call as the network would at its second. Reverts if it is not due,
    /// already ran or was deleted; the call's own failure is reported, not bubbled up.
    function fire(uint256 index) external returns (bool success, bytes memory returnData) {
        ScheduledCall storage c = calls[index];
        require(!c.ran && !c.deleted, "not pending");
        require(block.timestamp >= c.expirySecond, "not due");
        c.ran = true;
        (success, returnData) = c.to.call{ gas: c.gasLimit, value: c.value }(c.callData);
        emit Fired(index, success, returnData);
    }
}
