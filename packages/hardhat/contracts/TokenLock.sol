// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TokenLock
/// @notice Holds one token until a release time, then pays everything it holds to a fixed
/// beneficiary. LaunchBlocks uses it to lock a SaucerSwap pool's LP tokens after a launch.
/// @dev There is no owner and nothing can be changed after deployment, so no one can move
/// the tokens early, including the deployer. Anyone may trigger the release once it is due;
/// the tokens only ever go to `beneficiary`.
///
/// On Hedera, `token` is an HTS token reached through its ERC-20 facade (its long-zero
/// address). The lock must be associated with the token before it can receive it: deploy it
/// with at least one automatic token association slot.
contract TokenLock {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    /// @notice Unix time, in seconds, from which `release` pays out.
    uint256 public immutable releaseTime;

    event Released(address indexed beneficiary, uint256 amount);

    error ZeroAddress();
    error BeneficiaryIsLock();
    error StillLocked(uint256 releaseTime);
    error NothingToRelease();

    /// @param token_ The token to hold.
    /// @param beneficiary_ Who receives the tokens on release.
    /// @param lockSeconds How long from deployment the tokens stay locked.
    constructor(address token_, address beneficiary_, uint256 lockSeconds) {
        if (token_ == address(0) || beneficiary_ == address(0)) revert ZeroAddress();
        if (beneficiary_ == address(this)) revert BeneficiaryIsLock();
        token = IERC20(token_);
        beneficiary = beneficiary_;
        releaseTime = block.timestamp + lockSeconds;
    }

    /// @notice How many token units the lock holds right now.
    function lockedAmount() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Pay everything the lock holds to the beneficiary, once the release time has come.
    /// @return amount The token units paid out.
    function release() external returns (uint256 amount) {
        if (block.timestamp < releaseTime) revert StillLocked(releaseTime);
        amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToRelease();
        emit Released(beneficiary, amount);
        token.safeTransfer(beneficiary, amount);
    }
}
