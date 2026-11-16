import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { installScheduleService } from "./helpers/scheduleService";

const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;
const GAS = 400_000;

describe("VestingSchedule", function () {
  async function baseFixture() {
    const [owner, beneficiary, funder, stranger] = await ethers.getSigners();
    const hss = await installScheduleService();
    const HederaToken = await ethers.getContractFactory("HederaToken");
    const token = await HederaToken.deploy(owner.address);
    await token.waitForDeployment();
    return { hss, token, owner, beneficiary, funder, stranger };
  }

  /** Deployed inside each test: a snapshot restore does not undo earlier time skips, and every
   * time a test checks is measured from this deployment. */
  async function deployVesting(
    base: Awaited<ReturnType<typeof baseFixture>>,
    { startDelay = HOUR, interval = DAY, tranches = 4, amount = ethers.parseEther("1000") } = {},
  ) {
    const Vesting = await ethers.getContractFactory("VestingSchedule");
    const vesting = await Vesting.deploy(
      await base.token.getAddress(),
      base.beneficiary.address,
      startDelay,
      interval,
      tranches,
      base.funder.address,
      GAS,
    );
    await vesting.waitForDeployment();
    const receipt = await vesting.deploymentTransaction()!.wait();
    const deployedAt = BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp);
    await base.token.transfer(await vesting.getAddress(), amount);
    return { vesting, deployedAt, amount, start: await vesting.start() };
  }

  describe("Deployment", function () {
    it("records the schedule, with the first tranche startDelay after deployment", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, deployedAt } = await deployVesting(base, { startDelay: 2 * HOUR, interval: DAY, tranches: 6 });
      expect(await vesting.beneficiary()).to.equal(base.beneficiary.address);
      expect(await vesting.start()).to.equal(deployedAt + BigInt(2 * HOUR));
      expect(await vesting.interval()).to.equal(BigInt(DAY));
      expect(await vesting.tranches()).to.equal(6n);
      expect(await vesting.nextReleaseTime()).to.equal(deployedAt + BigInt(2 * HOUR));
      expect(await vesting.tranchesDue()).to.equal(0n);
    });

    it("rejects an empty or oversized schedule, a sub-minute interval and zero addresses", async function () {
      const { token, beneficiary, funder } = await loadFixture(baseFixture);
      const Vesting = await ethers.getContractFactory("VestingSchedule");
      const t = await token.getAddress();
      const deploy = (tranches: number, interval: number, b = beneficiary.address, r = funder.address) =>
        Vesting.deploy(t, b, HOUR, interval, tranches, r, GAS);
      await expect(deploy(0, DAY)).to.be.revertedWithCustomError(Vesting, "BadSchedule");
      await expect(deploy(121, DAY)).to.be.revertedWithCustomError(Vesting, "BadSchedule");
      await expect(deploy(4, 59)).to.be.revertedWithCustomError(Vesting, "BadSchedule");
      await expect(deploy(4, DAY, ethers.ZeroAddress)).to.be.revertedWithCustomError(Vesting, "ZeroAddress");
      await expect(deploy(4, DAY, beneficiary.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Vesting,
        "ZeroAddress",
      );
    });
  });

  describe("The network's runs", function () {
    it("books the first tranche, pays a quarter of four, and books the next", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, amount, start } = await deployVesting(base);
      await vesting.arm({ value: ethers.parseEther("1") });
      expect((await base.hss.callAt(0)).expirySecond).to.equal(start);

      await time.increaseTo(start);
      await expect(base.hss.fire(0))
        .to.emit(vesting, "TranchesPaid")
        .withArgs(0, 1, amount / 4n);
      expect(await base.token.balanceOf(base.beneficiary.address)).to.equal(amount / 4n);
      expect(await vesting.paid()).to.equal(1n);
      expect((await base.hss.callAt(1)).expirySecond).to.equal(start + BigInt(DAY));
      expect(await vesting.pendingExpiry()).to.equal(start + BigInt(DAY));
    });

    it("pays every tranche due when a run comes late", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, amount, start } = await deployVesting(base);
      await vesting.arm();
      await time.increaseTo(start + BigInt(2 * DAY + 5));
      await expect(base.hss.fire(0))
        .to.emit(vesting, "TranchesPaid")
        .withArgs(0, 3, (amount * 3n) / 4n);
      expect((await base.hss.callAt(1)).expirySecond).to.equal(start + BigInt(3 * DAY));
    });

    it("pays the exact remainder on the last tranche, refunds the HBAR and books nothing more", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, amount, start } = await deployVesting(base, { tranches: 3 });
      const hbar = ethers.parseEther("1");
      await vesting.arm({ value: hbar });
      for (let i = 0; i < 3; i++) {
        await time.increaseTo(start + BigInt(i * DAY));
        if (i < 2) await base.hss.fire(i);
        else await expect(base.hss.fire(i)).to.emit(vesting, "Refunded").withArgs(base.funder.address, hbar);
      }
      expect(await base.token.balanceOf(base.beneficiary.address)).to.equal(amount);
      expect(await vesting.remaining()).to.equal(0n);
      expect(await base.hss.callCount()).to.equal(3n);
      expect(await vesting.pendingExpiry()).to.equal(0n);
      await expect(vesting.arm()).to.be.revertedWithCustomError(vesting, "Finished");
    });

    it("hops toward a start beyond the network's horizon without paying early", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, start } = await deployVesting(base, { startDelay: 90 * DAY });
      await vesting.arm();
      const hop = (await base.hss.callAt(0)).expirySecond;
      expect(hop).to.be.lessThan(start);

      await time.increaseTo(hop);
      await expect(base.hss.fire(0)).to.not.emit(vesting, "TranchesPaid");
      expect((await base.hss.callAt(1)).expirySecond).to.equal(start);
      expect(await vesting.paid()).to.equal(0n);
    });

    it("cannot run or pay before its second", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, start } = await deployVesting(base);
      await vesting.arm();
      await expect(vesting.connect(base.stranger).onSchedule())
        .to.be.revertedWithCustomError(vesting, "NotDue")
        .withArgs(start);
      await expect(vesting.connect(base.stranger).release())
        .to.be.revertedWithCustomError(vesting, "NothingDue")
        .withArgs(start);
    });
  });

  describe("Manual fallback", function () {
    it("pays a due tranche when the network's run did not happen, and books the next", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, amount, start } = await deployVesting(base);
      await vesting.arm();
      await time.increaseTo(start + 10n);
      await vesting.connect(base.stranger).release();
      expect(await base.token.balanceOf(base.beneficiary.address)).to.equal(amount / 4n);
      expect((await base.hss.callAt(0)).deleted).to.equal(true);
      expect((await base.hss.callAt(1)).expirySecond).to.equal(start + BigInt(DAY));
    });

    it("keeps a future booking and refuses when nothing is due", async function () {
      const base = await loadFixture(baseFixture);
      const { vesting, start } = await deployVesting(base);
      await vesting.arm();
      await time.increaseTo(start);
      await base.hss.fire(0);
      await expect(vesting.release())
        .to.be.revertedWithCustomError(vesting, "NothingDue")
        .withArgs(start + BigInt(DAY));
      expect(await vesting.pendingExpiry()).to.equal(start + BigInt(DAY));
    });
  });
});
