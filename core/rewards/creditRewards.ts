import {
  ICreditConfigurator__factory,
  ICreditFacade__factory,
  ICreditManagerV2__factory,
} from "@gearbox-protocol/sdk";
import {
  CloseCreditAccountEvent,
  IncreaseBorrowedAmountEvent,
  OpenCreditAccountEvent,
  TransferAccountEvent,
} from "@gearbox-protocol/sdk/lib/types/@gearbox-protocol/core-v2/contracts/interfaces/ICreditFacade.sol/ICreditFacade";
import { TypedEvent } from "@gearbox-protocol/sdk/lib/types/common";
import { BigNumber, providers } from "ethers";

import { creditRewardsPerBlock } from "./creditRewardParams";
import { Reward } from "./poolRewards";
import { RangedValue } from "./range";

export class CreditRewards {
  static async computeReward(
    creditManager: string,
    address: string,
    provider: providers.Provider,
    toBlock?: number,
  ): Promise<BigNumber> {
    const rewards = await CreditRewards.computeAllRewards(
      creditManager,
      provider,
      toBlock,
    );

    const rewardToAddress = rewards.filter(
      r => r.address === address.toLowerCase(),
    );

    return rewardToAddress.length === 0
      ? BigNumber.from(0)
      : rewardToAddress[0].amount;
  }

  static async computeAllRewards(
    creditManager: string,
    provider: providers.Provider,
    toBlock?: number,
  ): Promise<Array<Reward>> {
    const toBlockQuery = toBlock || (await provider.getBlockNumber());

    const cm = ICreditManagerV2__factory.connect(creditManager, provider);
    const cc = ICreditConfigurator__factory.connect(
      await cm.creditConfigurator(),
      provider,
    );

    const creditFacadesEvents = await cc.queryFilter(
      cc.filters.CreditFacadeUpgraded(),
    );

    const events: Array<TypedEvent> = [];

    for (const cfe of creditFacadesEvents) {
      const query = await CreditRewards.query(
        cfe.args.newCreditFacade,
        provider,
        toBlockQuery,
      );
      events.push(...query);
    }

    const rewardPerBlock = CreditRewards.getRewardsRange(
      creditManager.toLowerCase(),
    );

    return CreditRewards.parseEvents(events, rewardPerBlock, toBlockQuery);
  }

  static parseEvents(
    events: Array<TypedEvent>,
    rewardPerBlock: RangedValue,
    toBlock: number,
  ): Array<Reward> {
    const { borrowedRange, totalBorrowedRange, borrowed } =
      CreditRewards.parseCMEvents(events);

    return Object.keys(borrowed).map(address => ({
      address: address.toLowerCase(),
      amount: CreditRewards.computeRewardInt(
        toBlock,
        borrowedRange[address],
        totalBorrowedRange,
        rewardPerBlock,
      ),
    }));
  }

  static parseCMEvents(events: Array<TypedEvent>) {
    const borrowedRange: Record<string, RangedValue> = {};
    const totalBorrowedRange = new RangedValue();

    const borrowed: Record<string, BigNumber> = {};
    let totalBorrowed = BigNumber.from(0);

    const cfi = ICreditFacade__factory.createInterface();

    events.forEach(e => {
      const event = cfi.parseLog(e);
      switch (e.topics[0]) {
        case cfi.getEventTopic("OpenCreditAccount"): {
          const { onBehalfOf, borrowAmount } = (
            event as unknown as OpenCreditAccountEvent
          ).args;
          totalBorrowed = totalBorrowed.add(borrowAmount);
          totalBorrowedRange.addValue(e.blockNumber, totalBorrowed);

          borrowed[onBehalfOf] = borrowAmount;

          if (!borrowedRange[onBehalfOf]) {
            borrowedRange[onBehalfOf] = new RangedValue();
          }
          borrowedRange[onBehalfOf].addValue(e.blockNumber, borrowAmount);
          break;
        }
        case cfi.getEventTopic("CloseCreditAccount"):
        case cfi.getEventTopic("LiquidateCreditAccount"):
        case cfi.getEventTopic("LiquidateExpiredCreditAccount"): {
          // We need { borrower} only so, we can use any event to get it from args
          const { borrower } = (event as unknown as CloseCreditAccountEvent)
            .args;
          totalBorrowed = totalBorrowed.sub(borrowed[borrower]);
          totalBorrowedRange.addValue(e.blockNumber, totalBorrowed);

          borrowed[borrower] = BigNumber.from(0);
          borrowedRange[borrower].addValue(e.blockNumber, BigNumber.from(0));
          break;
        }
        case cfi.getEventTopic("IncreaseBorrowedAmount"): {
          const { borrower, amount } = (
            event as unknown as IncreaseBorrowedAmountEvent
          ).args;
          totalBorrowed = totalBorrowed.add(amount);
          totalBorrowedRange.addValue(e.blockNumber, totalBorrowed);

          borrowed[borrower] = borrowed[borrower].add(amount);
          borrowedRange[borrower].addValue(e.blockNumber, borrowed[borrower]);
          break;
        }
        case cfi.getEventTopic("DecreaseBorrowedAmount"): {
          const { borrower, amount } = (
            event as unknown as IncreaseBorrowedAmountEvent
          ).args;
          totalBorrowed = totalBorrowed.sub(amount);
          totalBorrowedRange.addValue(e.blockNumber, totalBorrowed);

          borrowed[borrower] = borrowed[borrower].sub(amount);
          borrowedRange[borrower].addValue(e.blockNumber, borrowed[borrower]);
          break;
        }
        case cfi.getEventTopic("TransferAccount"): {
          const { newOwner, oldOwner } = (
            event as unknown as TransferAccountEvent
          ).args;
          borrowed[newOwner] = borrowed[oldOwner];

          if (!borrowedRange[newOwner]) {
            borrowedRange[newOwner] = new RangedValue();
          }

          borrowed[oldOwner] = BigNumber.from(0);
          borrowedRange[newOwner].addValue(e.blockNumber, borrowed[newOwner]);
          borrowedRange[oldOwner].addValue(e.blockNumber, BigNumber.from(0));
          break;
        }
      }
    });

    return {
      borrowedRange,
      totalBorrowedRange,
      borrowed,
      totalBorrowed,
    };
  }

  static async computeCMStats(
    creditManager: string,
    provider: providers.Provider,
    toBlock?: number,
  ) {
    const toBlockQuery = toBlock || (await provider.getBlockNumber());

    const cm = ICreditManagerV2__factory.connect(creditManager, provider);
    const cc = ICreditConfigurator__factory.connect(
      await cm.creditConfigurator(),
      provider,
    );

    const creditFacadesEvents = await cc.queryFilter(
      cc.filters.CreditFacadeUpgraded(),
    );

    const events: Array<TypedEvent> = [];

    for (const cfe of creditFacadesEvents) {
      const query = await CreditRewards.query(
        cfe.args.newCreditFacade,
        provider,
        toBlockQuery,
      );
      events.push(...query);
    }

    return CreditRewards.parseCMEvents(events);
  }

  static computeRewardInt(
    toBlock: number,
    balance: RangedValue,
    totalSupply: RangedValue,
    rewardPerBlock: RangedValue,
  ): BigNumber {
    const keys = Array.from(
      new Set([
        ...balance.keys,
        ...totalSupply.keys,
        ...rewardPerBlock.keys,
        toBlock,
      ]),
    ).sort((a, b) => (a > b ? 1 : -1));

    let total = BigNumber.from(0);

    const balancesArr = balance.getValues(keys);
    const totalSupplyArr = totalSupply.getValues(keys);
    const rewardsArr = rewardPerBlock.getValues(keys);

    for (let i = 0; i < keys.length; i++) {
      const curBlock = keys[i];
      const nextBlock = i === keys.length - 1 ? toBlock : keys[i + 1];
      if (!totalSupplyArr[i].isZero()) {
        total = total.add(
          balancesArr[i]
            .mul(nextBlock - curBlock)
            .mul(rewardsArr[i])
            .div(totalSupplyArr[i]),
        );
      }
    }

    return total;
  }

  protected static async query(
    creditFacade: string,
    provider: providers.Provider,
    toBlock: number,
  ): Promise<Array<TypedEvent>> {
    const cf = ICreditFacade__factory.connect(creditFacade, provider);
    const topics = {
      OpenCreditAccount: cf.interface.getEventTopic("OpenCreditAccount"),
      CloseCreditAccount: cf.interface.getEventTopic("CloseCreditAccount"),
      LiquidateCreditAccount: cf.interface.getEventTopic(
        "LiquidateCreditAccount",
      ),
      LiquidateExpiredCreditAccount: cf.interface.getEventTopic(
        "LiquidateExpiredCreditAccount",
      ),
      TransferAccount: cf.interface.getEventTopic("TransferAccount"),
      IncreaseBorrowedAmount: cf.interface.getEventTopic(
        "IncreaseBorrowedAmount",
      ),
      DecreaseBorrowedAmount: cf.interface.getEventTopic(
        "DecreaseBorrowedAmount",
      ),
    };

    const logs = await cf.queryFilter(
      {
        address: cf.address,
        topics: [Object.values(topics)],
      },
      undefined,
      toBlock,
    );

    return logs;
  }

  protected static getRewardsRange(creditManager: string): RangedValue {
    const rewardPerBlock = creditRewardsPerBlock[creditManager];

    if (!rewardPerBlock)
      throw new Error(`Unknown credit manager token ${creditManager}`);
    return rewardPerBlock;
  }
}
