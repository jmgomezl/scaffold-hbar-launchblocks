// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IHederaScheduleService
/// @notice The HIP-1215 functions of the Hedera Schedule Service system contract (address 0x16b)
/// that LaunchBlocks contracts use: a contract books a call to itself that the network runs at a
/// chosen second, so no off-chain keeper is needed.
/// @dev Signatures match hiero-ledger/hiero-contracts `contracts/schedule-service/IHRC1215.sol`.
/// Response codes are HAPI `ResponseCodeEnum` ordinals: 22 SUCCESS, 306 the second is too far in
/// the future, 307 it is not in the future, 370 that second has no capacity left.
interface IHederaScheduleService {
    /// @notice Book a call to `to` that the network runs once consensus time reaches `expirySecond`.
    /// The calling contract pays for the call when it runs, so it must hold enough HBAR by then.
    /// @param value Tinybars to send with the future call.
    /// @return responseCode 22 on success.
    /// @return scheduleAddress The schedule's address, or zero when booking failed.
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /// @notice Delete a schedule this contract created, before it runs.
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);

    /// @notice Whether `expirySecond` can still take a call with `gasLimit`; each second has a
    /// network-wide budget of scheduled gas.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);
}
