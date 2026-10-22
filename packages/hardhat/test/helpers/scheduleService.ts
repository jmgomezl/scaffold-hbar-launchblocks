import { ethers, network } from "hardhat";

/** Where Hedera's Schedule Service system contract lives. */
export const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";

/** Put the Schedule Service test double at 0x16b and return it. Use inside a `loadFixture`
 * fixture: the double keeps its state at that address across tests otherwise, and installing it
 * resets whatever an earlier suite left there. */
export async function installScheduleService() {
  const Mock = await ethers.getContractFactory("MockHederaScheduleService");
  const mock = await Mock.deploy();
  await mock.waitForDeployment();
  const code = await ethers.provider.getCode(await mock.getAddress());
  await network.provider.send("hardhat_setCode", [HSS_ADDRESS, code]);
  const hss = await ethers.getContractAt("MockHederaScheduleService", HSS_ADDRESS);
  await hss.reset();
  return hss;
}
