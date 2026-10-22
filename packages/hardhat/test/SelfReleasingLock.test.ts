import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";
const DAY = 24 * 60 * 60;
const GAS = 400_000;

/** Put the Schedule Service test double where Hedera's system contract lives. */
async function installScheduleService() {
  const Mock = await ethers.getContractFactory("MockHederaScheduleService");
  const mock = await Mock.deploy();
  await mock.waitForDeployment();
  const code = await ethers.provider.getCode(await mock.getAddress());
  await network.provider.send("hardhat_setCode", [HSS_ADDRESS, code]);
  return ethers.getContractAt("MockHederaScheduleService", HSS_ADDRESS);
}

describe("SelfReleasingLock", function () {
  async function deployWith(lockSeconds: number) {
    const [owner, beneficiary, funder, stranger] = await ethers.getSigners();
    const hss = await installScheduleService();
    const HederaToken = await ethers.getContractFactory("HederaToken");
    const token = await HederaToken.deploy(owner.address);
    await token.waitForDeployment();

    const Lock = await ethers.getContractFactory("SelfReleasingLock");
    const lock = await Lock.deploy(await token.getAddress(), beneficiary.address, lockSeconds, funder.address, GAS);
    await lock.waitForDeployment();
    const receipt = await lock.deploymentTransaction()!.wait();
    const deployedAt = BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp);
    const amount = ethers.parseEther("250");
    await token.transfer(await lock.getAddress(), amount);
    return { hss, token, lock, amount, deployedAt, owner, beneficiary, funder, stranger };
  }
  // Each test starts from a snapshot: the Schedule Service double keeps its state at 0x16b otherwise.
  const lock30Days = () => deployWith(30 * DAY);
  const deployFixture = () => loadFixture(lock30Days);

  const onScheduleData = (lock: Awaited<ReturnType<typeof deployFixture>>["lock"]) =>
    lock.interface.encodeFunctionData("onSchedule");

  describe("Deployment", function () {
    it("records the token, the beneficiary, the refund address and a release time lockSeconds ahead", async function () {
      const { token, lock, deployedAt, beneficiary, funder } = await deployFixture();
      expect(await lock.token()).to.equal(await token.getAddress());
      expect(await lock.beneficiary()).to.equal(beneficiary.address);
      expect(await lock.refundTo()).to.equal(funder.address);
      expect(await lock.releaseTime()).to.equal(deployedAt + BigInt(30 * DAY));
      expect(await lock.pendingExpiry()).to.equal(0n);
    });

    it("rejects zero addresses and a scheduled gas limit out of range", async function () {
      const { token, beneficiary, funder } = await deployFixture();
      const Lock = await ethers.getContractFactory("SelfReleasingLock");
      const t = await token.getAddress();
      await expect(
        Lock.deploy(ethers.ZeroAddress, beneficiary.address, DAY, funder.address, GAS),
      ).to.be.revertedWithCustomError(Lock, "ZeroAddress");
      await expect(Lock.deploy(t, ethers.ZeroAddress, DAY, funder.address, GAS)).to.be.revertedWithCustomError(
        Lock,
        "ZeroAddress",
      );
      await expect(Lock.deploy(t, beneficiary.address, DAY, ethers.ZeroAddress, GAS)).to.be.revertedWithCustomError(
        Lock,
        "ZeroAddress",
      );
      await expect(Lock.deploy(t, beneficiary.address, DAY, funder.address, 99_999))
        .to.be.revertedWithCustomError(Lock, "GasOutOfRange")
        .withArgs(99_999);
    });
  });

  describe("Arming", function () {
    it("books the network's call to onSchedule at the release time, with the lock as payer", async function () {
      const { hss, lock } = await deployFixture();
      const releaseTime = await lock.releaseTime();
      await expect(lock.arm({ value: ethers.parseEther("1") }))
        .to.emit(lock, "CallScheduled")
        .withArgs(await hss.scheduleAddressOf(0), releaseTime, releaseTime);

      const booked = await hss.callAt(0);
      expect(booked.to).to.equal(await lock.getAddress());
      expect(booked.payer).to.equal(await lock.getAddress());
      expect(booked.expirySecond).to.equal(releaseTime);
      expect(booked.gasLimit).to.equal(BigInt(GAS));
      expect(booked.callData).to.equal(onScheduleData(lock));
      expect(await lock.pendingExpiry()).to.equal(releaseTime);
      expect(await lock.pendingSchedule()).to.equal(await hss.scheduleAddressOf(0));
    });

    it("refuses a second booking while one is pending", async function () {
      const { lock } = await deployFixture();
      await lock.arm();
      await expect(lock.arm()).to.be.revertedWithCustomError(lock, "AlreadyScheduled");
    });

    it("moves to the next second when the release second is out of capacity", async function () {
      const { hss, lock } = await deployFixture();
      const releaseTime = await lock.releaseTime();
      await hss.setBusy(releaseTime, true);
      await hss.setBusy(releaseTime + 1n, true);
      await lock.arm();
      expect((await hss.callAt(0)).expirySecond).to.equal(releaseTime + 2n);
    });

    it("gives up after sixteen busy seconds", async function () {
      const { hss, lock } = await deployFixture();
      const releaseTime = await lock.releaseTime();
      for (let i = 0n; i < 16n; i++) await hss.setBusy(releaseTime + i, true);
      await expect(lock.arm()).to.be.revertedWithCustomError(lock, "NoCapacity").withArgs(releaseTime);
    });

    it("reverts with the Schedule Service's response code when booking fails", async function () {
      const { hss, lock } = await deployFixture();
      await hss.failNext(307);
      await expect(lock.arm()).to.be.revertedWithCustomError(lock, "ScheduleFailed").withArgs(307);
      expect(await lock.pendingExpiry()).to.equal(0n);
    });
  });

  describe("The network's run", function () {
    it("cannot run before its second, by the network or anyone else", async function () {
      const { hss, lock, stranger } = await deployFixture();
      await lock.arm();
      const releaseTime = await lock.releaseTime();
      await expect(lock.connect(stranger).onSchedule())
        .to.be.revertedWithCustomError(lock, "NotDue")
        .withArgs(releaseTime);
      await expect(hss.fire(0)).to.be.revertedWith("not due");
    });

    it("pays every token to the beneficiary and the unspent HBAR back to the funder", async function () {
      const { hss, token, lock, amount, beneficiary, funder } = await deployFixture();
      const hbar = ethers.parseEther("1");
      await lock.connect(funder).arm({ value: hbar });
      await time.increaseTo(await lock.releaseTime());

      const funderBefore = await ethers.provider.getBalance(funder.address);
      await expect(hss.fire(0))
        .to.emit(lock, "Released")
        .withArgs(beneficiary.address, amount)
        .and.to.emit(lock, "Refunded")
        .withArgs(funder.address, hbar);
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
      expect(await lock.lockedAmount()).to.equal(0n);
      expect(await ethers.provider.getBalance(funder.address)).to.equal(funderBefore + hbar);
      expect(await lock.pendingExpiry()).to.equal(0n);
    });

    it("reaches a lock beyond the network's horizon in hops", async function () {
      // Deployed here, not in the fixture: a snapshot restore does not undo earlier time skips,
      // and every time below must be measured from this deployment.
      const { hss, token, beneficiary, funder } = await deployFixture();
      const Lock = await ethers.getContractFactory("SelfReleasingLock");
      const lock = await Lock.deploy(await token.getAddress(), beneficiary.address, 90 * DAY, funder.address, GAS);
      const amount = ethers.parseEther("100");
      await token.transfer(await lock.getAddress(), amount);
      const releaseTime = await lock.releaseTime();
      await lock.arm();
      const firstHop = (await hss.callAt(0)).expirySecond;
      expect(firstHop).to.be.lessThan(releaseTime);
      expect(firstHop - BigInt(await time.latest())).to.be.lessThanOrEqual(BigInt(60 * DAY));

      await time.increaseTo(firstHop);
      await expect(hss.fire(0))
        .to.emit(lock, "CallScheduled")
        .withArgs(await hss.scheduleAddressOf(1), releaseTime, releaseTime);
      expect(await token.balanceOf(beneficiary.address)).to.equal(0n);

      await time.increaseTo(releaseTime);
      await hss.fire(1);
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
    });

    it("can be triggered by anyone once due, if the network's run did not happen", async function () {
      const { token, lock, amount, beneficiary, stranger } = await deployFixture();
      await lock.arm();
      await time.increaseTo(await lock.releaseTime());
      await lock.connect(stranger).onSchedule();
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
    });

    it("only refunds when there is nothing left to release", async function () {
      const { hss, token, lock, funder } = await deployFixture();
      await time.increaseTo(await lock.releaseTime());
      await lock.release();
      await token.transfer(await lock.getAddress(), 0n);
      await lock.connect(funder).arm({ value: 5n });
      await time.increase(2);
      await expect(hss.fire(0))
        .to.emit(lock, "Refunded")
        .withArgs(funder.address, 5n)
        .and.not.to.emit(lock, "Released");
    });
  });

  describe("Manual fallback", function () {
    it("refuses to release before the release time, even to the beneficiary", async function () {
      const { lock, beneficiary } = await deployFixture();
      await expect(lock.connect(beneficiary).release())
        .to.be.revertedWithCustomError(lock, "StillLocked")
        .withArgs(await lock.releaseTime());
    });

    it("releases once due and cancels the network's pending run", async function () {
      const { hss, token, lock, amount, beneficiary, stranger } = await deployFixture();
      await lock.arm({ value: 10n });
      await time.increaseTo(await lock.releaseTime());
      await lock.connect(stranger).release();
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
      expect(await lock.pendingExpiry()).to.equal(0n);
      expect((await hss.callAt(0)).deleted).to.equal(true);
      await expect(hss.fire(0)).to.be.revertedWith("not pending");
    });

    it("refuses to release when the lock is empty", async function () {
      const { lock } = await deployFixture();
      await time.increaseTo(await lock.releaseTime());
      await lock.release();
      await expect(lock.release()).to.be.revertedWithCustomError(lock, "NothingToRelease");
    });

    it("will not refund while it still holds tokens, so nobody can cancel the release", async function () {
      const { lock, stranger } = await deployFixture();
      await lock.arm({ value: 10n });
      await expect(lock.connect(stranger).refund()).to.be.revertedWithCustomError(lock, "StillLocked");
      await time.increaseTo(await lock.releaseTime());
      await expect(lock.connect(stranger).refund()).to.be.revertedWithCustomError(lock, "StillHolding");
      expect(await lock.pendingExpiry()).to.not.equal(0n);
    });
  });
});
