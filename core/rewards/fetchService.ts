type Action<T> = (start: number, end: number) => Promise<Array<T>>;

type ParseEventsProps<T> = {
  action: Action<T>;
  initialOffset?: number;
  start: number;
  end: number;

  loggerPrefix?: string;
  loggerEnabled?: boolean;
};

type State<T> = {
  acc: Array<T>;
  logger: Logger;
  counter: Counter;
};

type ReadEventsRangeProps<T> = {
  action: Action<T>;
  start: number;
  end: number;
  state: State<T>;
};

const ERROR_10K = "query returned more than 10000 results";

export class UniversalQuery {
  static async query<T>({
    action,
    initialOffset,
    start,
    end,

    loggerPrefix,
    loggerEnabled,
  }: ParseEventsProps<T>) {
    const arr: Array<T> = [];
    const logger = new Logger(loggerPrefix, loggerEnabled);
    const counter = new Counter();

    initialOffset
      ? await this.recursiveQuery({
          action,
          start: 0,
          end: initialOffset,
          state: {
            acc: arr,
            logger,
            counter,
          },
        })
      : undefined;
    await this.recursiveQuery({
      action,
      start,
      end,
      state: {
        acc: arr,
        logger,
        counter,
      },
    });

    return arr;
  }

  private static async recursiveQuery<T>({
    action,
    start,
    end,
    state,
  }: ReadEventsRangeProps<T>) {
    state.counter.add(1);
    const currentJob = state.counter.getCount();
    // state.logger.logJobStart(start, end, currentJob);

    try {
      const result = await action(start, end);
      state.acc.push(...result);
      state.logger.logJobEnd(start, end, currentJob);
    } catch (e: any) {
      if (this.is10kError(e)) {
        const middle = Math.round((start + end) / 2);
        state.logger.logLimit(start, end, middle);

        await this.recursiveQuery({
          action,
          start,
          end: middle,
          state,
        });
        await this.recursiveQuery({
          action,
          start: middle + 1,
          end,
          state,
        });
      }
    }
  }

  private static is10kError(e: any) {
    return (
      e &&
      typeof e === "object" &&
      e.message &&
      typeof e.message === "string" &&
      e.message.toLowerCase().includes(ERROR_10K)
    );
  }
}

class Counter {
  private count: number;

  constructor() {
    this.count = 0;
  }

  add(amount: number) {
    this.count = this.count + amount;
  }

  getCount() {
    return this.count;
  }
}

class Logger {
  prefix: string;
  enabled: boolean;

  constructor(prefix?: string, enabled = false) {
    this.prefix = prefix ? `${prefix}: ` : "";
    this.enabled = enabled;
  }

  logLimit(start: number, end: number, middle: number) {
    this.log(
      `${
        this.prefix
      }Event limit exceeded [${start}..${end}] -> [${start}..${middle}] and [${
        middle + 1
      }..${end}]`,
    );
  }

  logJobStart(start: number, end: number, jobCount: number) {
    this.log(`${this.prefix}Start job [${start}..${end}] => #${jobCount}`);
  }

  logJobEnd(start: number, end: number, jobCount: number) {
    this.log(`${this.prefix}End job [${start}..${end}] => #${jobCount}`);
  }

  private log(msg: string) {
    if (this.enabled) {
      console.debug(msg);
    }
  }
}
