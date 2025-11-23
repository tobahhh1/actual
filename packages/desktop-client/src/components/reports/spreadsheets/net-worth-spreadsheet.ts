import * as d from 'date-fns';
import { type Locale } from 'date-fns';
import keyBy from 'lodash/keyBy';

import { send } from 'loot-core/platform/client/fetch';
import * as monthUtils from 'loot-core/shared/months';
import { q } from 'loot-core/shared/query';
import {
  type AccountEntity,
  type RuleConditionEntity,
} from 'loot-core/types/models';

import { getAccountPredictedNet } from '@desktop-client/components/reports/future-transactions';
import { ReportOptions } from '@desktop-client/components/reports/ReportOptions';
import { type FormatType } from '@desktop-client/hooks/useFormat';
import { type useSpreadsheet } from '@desktop-client/hooks/useSpreadsheet';
import { aqlQuery } from '@desktop-client/queries/aqlQuery';

type Balance = {
  date: string;
  amount: number;
};

export function createSpreadsheet(
  start: string,
  end: string,
  accounts: AccountEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  locale: Locale,
  interval: string = 'Monthly',
  firstDayOfWeekIdx: string = '0',
  format: (value: unknown, type?: FormatType) => string,
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof recalculate>) => void,
  ) => {
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    const startDate = monthUtils.dayFromDate(start);
    const endDate = monthUtils.dayFromDate(end);

    const hasFutureDates = monthUtils.isAfter(endDate, monthUtils.currentDay());
    const historicalEndDate = hasFutureDates
      ? monthUtils.currentDay()
      : endDate;

    const data = await Promise.all(
      accounts.map(async acct => {
        const [starting, balances]: [number, Balance[]] = await Promise.all([
          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
                account: acct.id,
                date: { $lt: startDate },
              })
              .calculate({ $sum: '$amount' }),
          ).then(({ data }) => data),

          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
              })
              .filter({
                account: acct.id,
                $and: [
                  { date: { $gte: startDate } },
                  { date: { $lte: historicalEndDate } },
                ],
              })
              .groupBy(
                interval === 'Yearly'
                  ? { $year: '$date' }
                  : interval === 'Daily' || interval === 'Weekly'
                    ? 'date'
                    : { $month: '$date' },
              )
              .select([
                {
                  date:
                    interval === 'Yearly'
                      ? { $year: '$date' }
                      : interval === 'Daily' || interval === 'Weekly'
                        ? 'date'
                        : { $month: '$date' },
                },
                { amount: { $sum: '$amount' } },
              ]),
          ).then(({ data }) => data),
        ]);

        // No aggregation is done by DB on weeks, so we need to do it here
        let processedBalances: Record<string, Balance>;
        if (interval === 'Weekly') {
          // Group transactions by week and sum their amounts
          const weeklyBalances: Record<string, number> = {};
          balances.forEach(b => {
            const weekDate = monthUtils.weekFromDate(b.date, firstDayOfWeekIdx);
            weeklyBalances[weekDate] =
              (weeklyBalances[weekDate] || 0) + b.amount;
          });

          // Convert back to Balance format
          processedBalances = {};
          Object.entries(weeklyBalances).forEach(([date, amount]) => {
            processedBalances[date] = { date, amount };
          });
        } else {
          processedBalances = keyBy(balances, 'date');
        }

        if (hasFutureDates) {
          let futureRange: Array<string>;
          if (interval === 'Daily') {
            futureRange = monthUtils.dayRangeInclusive(
              monthUtils.addDays(historicalEndDate, 1),
              endDate,
            );
          } else if (interval === 'Weekly') {
            futureRange = monthUtils.weekRangeInclusive(
              monthUtils.addWeeks(historicalEndDate, 1),
              endDate,
              firstDayOfWeekIdx,
            );
          } else if (interval === 'Yearly') {
            futureRange = monthUtils.yearRangeInclusive(
              monthUtils.addYears(historicalEndDate, 1),
              endDate,
            );
          } else {
            futureRange = monthUtils.rangeInclusive(
              monthUtils.addMonths(historicalEndDate, 1),
              endDate,
            );
          }
          // For future dates, get predicted balances
          let todayBalance = starting;
          for (const date in processedBalances) {
            if (monthUtils.isBefore(date, monthUtils.addDays(historicalEndDate, 1))) {
              todayBalance += processedBalances[date].amount;
            }
          }
          let prevBalance = todayBalance;
          let prevEndDate = historicalEndDate;
          for (const futureDate of futureRange) {
            console.log('Getting predictions for', acct.id, prevEndDate, futureDate, prevBalance);
            const predictions = await getAccountPredictedNet(
              acct.id,
              prevEndDate,
              monthUtils.subDays(futureDate, 1),
              prevBalance,
            );
            prevBalance += predictions.net;
            prevEndDate = futureDate;
            processedBalances[futureDate] = { date: futureDate, amount: predictions.net };
          }
        }

        return {
          id: acct.id,
          balances: processedBalances,
          starting,
        };
      }),
    );

    setData(
      recalculate(
        data,
        startDate,
        endDate,
        locale,
        interval,
        firstDayOfWeekIdx,
        format,
      ),
    );
  };
}

function recalculate(
  data: Array<{
    id: string;
    balances: Record<string, Balance>;
    starting: number;
  }>,
  startDate: string,
  endDate: string,
  locale: Locale,
  interval: string = 'Monthly',
  firstDayOfWeekIdx: string = '0',
  format: (value: unknown, type?: FormatType) => string,
) {
  // Get intervals using the same pattern as other working spreadsheets
  const intervals =
    interval === 'Weekly'
      ? monthUtils.weekRangeInclusive(startDate, endDate, firstDayOfWeekIdx)
      : interval === 'Daily'
        ? monthUtils.dayRangeInclusive(startDate, endDate)
        : interval === 'Yearly'
          ? monthUtils.yearRangeInclusive(startDate, endDate)
          : monthUtils.rangeInclusive(
              monthUtils.getMonth(startDate),
              monthUtils.getMonth(endDate),
            );

  const accountBalances = data.map(account => {
    let balance = account.starting;
    return intervals.map(intervalItem => {
      if (account.balances[intervalItem]) {
        balance += account.balances[intervalItem].amount;
      }
      return balance;
    });
  });

  let hasNegative = false;
  let startNetWorth = 0;
  let endNetWorth = 0;
  let lowestNetWorth: number | null = null;
  let highestNetWorth: number | null = null;

  const graphData = intervals.reduce<
    Array<{
      x: string;
      y: number;
      assets: string;
      debt: string;
      change: string;
      networth: string;
      date: string;
    }>
  >((arr, intervalItem, idx) => {
    let debt = 0;
    let assets = 0;
    let total = 0;
    const last = arr.length === 0 ? null : arr[arr.length - 1];

    accountBalances.forEach(balances => {
      const balance = balances[idx];
      if (balance < 0) {
        debt += -balance;
      } else {
        assets += balance;
      }
      total += balance;
    });

    if (total < 0) {
      hasNegative = true;
    }

    // Parse dates based on interval type - following the working pattern
    let x: Date;
    if (interval === 'Daily' || interval === 'Weekly') {
      x = d.parseISO(intervalItem);
    } else if (interval === 'Yearly') {
      x = d.parseISO(intervalItem + '-01-01');
    } else {
      x = d.parseISO(intervalItem + '-01');
    }

    const change = last ? total - last.y : 0;

    if (arr.length === 0) {
      startNetWorth = total;
    }
    endNetWorth = total;

    // Use standardized format from ReportOptions
    const displayFormat =
      ReportOptions.intervalFormat.get(interval) ?? 'MMM ‘yy';

    const tooltipFormat =
      interval === 'Daily'
        ? 'MMMM d, yyyy'
        : interval === 'Weekly'
          ? 'MMM d, yyyy'
          : interval === 'Yearly'
            ? 'yyyy'
            : 'MMMM yyyy';

    const graphPoint = {
      x: d.format(x, displayFormat, { locale }),
      y: total,
      assets: format(Math.trunc(assets), 'financial'),
      debt: `-${format(Math.trunc(debt), 'financial')}`,
      change: format(Math.trunc(change), 'financial'),
      networth: format(Math.trunc(total), 'financial'),
      date: d.format(x, tooltipFormat, { locale }),
    };

    arr.push(graphPoint);

    // Track min/max for the current point only
    if (lowestNetWorth === null || graphPoint.y < lowestNetWorth) {
      lowestNetWorth = graphPoint.y;
    }
    if (highestNetWorth === null || graphPoint.y > highestNetWorth) {
      highestNetWorth = graphPoint.y;
    }

    return arr;
  }, []);

  return {
    graphData: {
      data: graphData,
      hasNegative,
      start: startDate,
      end: endDate,
    },
    netWorth: Math.trunc(endNetWorth),
    totalChange: Math.trunc(endNetWorth - startNetWorth),
    lowestNetWorth: lowestNetWorth ? Math.trunc(lowestNetWorth) : null,
    highestNetWorth: highestNetWorth ? Math.trunc(highestNetWorth) : null,
  };
}
