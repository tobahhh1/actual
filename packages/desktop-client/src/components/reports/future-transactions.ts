/**
 * Helper functions for calculating predicted future account balances
 * based on scheduled transactions and budget data.
 */

import { send } from 'loot-core/platform/client/fetch';

type PredictedBalance = {
  net: number;
  breakdown: {
    scheduledIncome: number;
    scheduledExpenses: number;
    budgetedIncome: number;
    budgetedExpenses: number;
    interestAccrued: number;
  };
};

/**
 * Get predicted balance changes for an account over a date range
 */
export async function getAccountPredictedNet(
  accountId: string,
  startDate: string,
  endDate: string,
  balance_at_start_date?: number,
): Promise<PredictedBalance> {
  return send('api/account-predicted-net', {
    accountId,
    startDate,
    endDate,
    balance_at_start_date,
  });
}
