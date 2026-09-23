import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("TokenLock", function () {
  const LOCK_SECONDS = 30 * 24 * 60 * 60;

  async function deployFixture() {
    const [owner, beneficiary, stranger] = await ethers.getSigners();
    const HederaToken = await ethers.getContractFactory("HederaToken");
    const token = await HederaToken.deploy(owner.address);
    await token.waitForDeployment();

    const TokenLock = await ethers.getContractFactory("TokenLock");
    const lock = await TokenLock.deploy(await token.getAddress(), beneficiary.address, LOCK_SECONDS);
    await lock.waitForDeployment();
    return { token, lock, owner, beneficiary, stranger };
  }

  describe("Deployment", function () {
    it("records the token, the beneficiary and a release time lockSeconds ahead", async function () {
      const { token, lock, beneficiary } = await deployFixture();
      expect(await lock.token()).to.equal(await token.getAddress());
      expect(await lock.beneficiary()).to.equal(beneficiary.address);
      expect(await lock.releaseTime()).to.equal(BigInt(await time.latest()) + BigInt(LOCK_SECONDS));
    });

    it("rejects a zero token or beneficiary", async function () {
      const { token, beneficiary } = await deployFixture();
      const TokenLock = await ethers.getContractFactory("TokenLock");
      await expect(
        TokenLock.deploy(ethers.ZeroAddress, beneficiary.address, LOCK_SECONDS),
      ).to.be.revertedWithCustomError(TokenLock, "ZeroAddress");
      await expect(
        TokenLock.deploy(await token.getAddress(), ethers.ZeroAddress, LOCK_SECONDS),
      ).to.be.revertedWithCustomError(TokenLock, "ZeroAddress");
    });
  });

  describe("Locking", function () {
    it("reports what it holds", async function () {
      const { token, lock } = await deployFixture();
      const amount = ethers.parseEther("250");
      await token.transfer(await lock.getAddress(), amount);
      expect(await lock.lockedAmount()).to.equal(amount);
    });

    it("refuses to release before the release time, even to the beneficiary", async function () {
      const { token, lock, beneficiary } = await deployFixture();
      await token.transfer(await lock.getAddress(), ethers.parseEther("250"));
      const releaseTime = await lock.releaseTime();
      await expect(lock.connect(beneficiary).release())
        .to.be.revertedWithCustomError(lock, "StillLocked")
        .withArgs(releaseTime);
    });
  });

  describe("Releasing", function () {
    it("pays everything to the beneficiary once due, whoever triggers it", async function () {
      const { token, lock, beneficiary, stranger } = await deployFixture();
      const amount = ethers.parseEther("250");
      await token.transfer(await lock.getAddress(), amount);
      await time.increaseTo(await lock.releaseTime());

      await expect(lock.connect(stranger).release()).to.emit(lock, "Released").withArgs(beneficiary.address, amount);
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
      expect(await token.balanceOf(stranger.address)).to.equal(0n);
      expect(await lock.lockedAmount()).to.equal(0n);
    });

    it("refuses to release when it holds nothing", async function () {
      const { lock } = await deployFixture();
      await time.increaseTo(await lock.releaseTime());
      await expect(lock.release()).to.be.revertedWithCustomError(lock, "NothingToRelease");
    });
  });
});
