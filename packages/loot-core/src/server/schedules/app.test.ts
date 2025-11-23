// @ts-strict-ignore
import MockDate from 'mockdate';

import { q } from '../../shared/query';
import { getNextDate } from '../../shared/schedules';
import { aqlQuery } from '../aql';
import { loadMappings } from '../db/mappings';
import { loadRules, updateRule } from '../transactions/transaction-rules';

import {
  updateConditions,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  setNextDate,
  countScheduleOccurrences,
} from './app';

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
});

describe('schedule app', () => {
  describe('utility', () => {
    it('conditions are updated when they exist', () => {
      const conds = [
        { op: 'is', field: 'payee', value: 'FOO' },
        { op: 'is', field: 'date', value: '2020-01-01' },
      ];

      const updated = updateConditions(conds, [
        {
          op: 'is',
          field: 'payee',
          value: 'bar',
        },
      ]);

      expect(updated.length).toBe(2);
      expect(updated[0].value).toBe('bar');
    });

    it('conditions are added if they don’t exist', () => {
      const conds = [
        { op: 'contains', field: 'payee', value: 'FOO' },
        { op: 'contains', field: 'notes', value: 'dflksjdflskdjf' },
      ];

      const updated = updateConditions(conds, [
        {
          op: 'is',
          field: 'payee',
          value: 'bar',
        },
      ]);

      expect(updated.length).toBe(3);
    });

    it('getNextDate works with date conditions', () => {
      expect(
        getNextDate({ op: 'is', field: 'date', value: '2021-04-30' }),
      ).toBe('2021-04-30');

      expect(
        getNextDate({
          op: 'is',
          field: 'date',
          value: {
            start: '2020-12-20',
            frequency: 'monthly',
            patterns: [
              { type: 'day', value: 15 },
              { type: 'day', value: 30 },
            ],
          },
        }),
      ).toBe('2020-12-30');
    });
  });

  describe('methods', () => {
    it('createSchedule creates a schedule', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const {
        data: [row],
      } = await aqlQuery(q('schedules').filter({ id }).select('*'));

      expect(row).toBeTruthy();
      expect(row.rule).toBeTruthy();
      expect(row.next_date).toBe('2020-12-30');

      await expect(
        createSchedule({
          conditions: [{ op: 'is', field: 'payee', value: 'p1' }],
        }),
      ).rejects.toThrow(/date condition is required/);
    });

    it('updateSchedule updates a schedule', async () => {
      const id = await createSchedule({
        conditions: [
          { op: 'is', field: 'payee', value: 'foo' },
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules')
          .filter({ id })
          .select(['next_date', 'posts_transaction']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-30');
      expect(row.posts_transaction).toBe(false);

      MockDate.set(new Date(2021, 4, 17));

      await updateSchedule({
        schedule: { id, posts_transaction: true },
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 18 },
                { type: 'day', value: 29 },
              ],
            },
          },
        ],
      });

      res = await aqlQuery(
        q('schedules')
          .filter({ id })
          .select(['next_date', 'posts_transaction']),
      );
      row = res.data[0];

      // Updating the date condition updates `next_date`
      expect(row.next_date).toBe('2021-05-18');
      expect(row.posts_transaction).toBe(true);
    });

    it('deleteSchedule deletes a schedule', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const { data: schedules } = await aqlQuery(q('schedules').select('*'));
      expect(schedules.length).toBe(1);

      await deleteSchedule({ id });
      const { data: schedules2 } = await aqlQuery(q('schedules').select('*'));
      expect(schedules2.length).toBe(0);
    });

    it('setNextDate sets `next_date`', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const { data: ruleId } = await aqlQuery(
        q('schedules').filter({ id }).calculate('rule'),
      );

      // Manually update the rule
      await updateRule({
        id: ruleId,
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 18 },
                { type: 'day', value: 28 },
              ],
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules').filter({ id }).select(['next_date']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-30');

      await setNextDate({ id });

      res = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));
      row = res.data[0];

      expect(row.next_date).toBe('2021-05-18');
    });
  });

  describe('countScheduleOccurrences', () => {
    it('counts daily occurrences', () => {
      const config = {
        start: '2021-01-01',
        frequency: 'daily' as const,
        endMode: 'never' as const,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-01-01',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-01-07',
        }),
      ).toBe(7);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-01-31',
        }),
      ).toBe(31);
    });

    it('counts daily occurrences with interval', () => {
      const config = {
        start: '2021-01-01',
        frequency: 'daily' as const,
        interval: 2,
        endMode: 'never' as const,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-01-07',
        }),
      ).toBe(4); // 1st, 3rd, 5th, 7th
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-01-10',
        }),
      ).toBe(5); // 1st, 3rd, 5th, 7th, 9th
    });

    it('counts weekly occurrences', () => {
      const config = {
        start: '2021-05-17', // Monday
        frequency: 'weekly' as const,
        endMode: 'never' as const,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2021-05-17',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2021-05-23',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2021-05-24',
        }),
      ).toBe(2);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2021-06-14',
        }),
      ).toBe(5);
    });

    it('counts monthly occurrences', () => {
      const config = {
        start: '2021-01-15',
        frequency: 'monthly' as const,
        endMode: 'never' as const,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-01-15',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-03-15',
        }),
      ).toBe(3);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-12-31',
        }),
      ).toBe(12);
    });

    it('counts monthly occurrences with patterns', () => {
      const config = {
        start: '2021-01-15',
        frequency: 'monthly' as const,
        patterns: [
          { type: 'day' as const, value: 15 },
          { type: 'day' as const, value: 30 },
        ],
        endMode: 'never' as const,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-01-15',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-01-30',
        }),
      ).toBe(2);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-02-28',
        }),
      ).toBe(3); // Jan 15, Jan 30, Feb 15
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-03-31',
        }),
      ).toBe(5); // Jan 15, Jan 30, Feb 15, Mar 15, Mar 30 (Feb has no 30th)
    });

    it('counts yearly occurrences', () => {
      const config = {
        start: '2021-05-17',
        frequency: 'yearly' as const,
        endMode: 'never' as const,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2021-05-17',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2022-05-16',
        }),
      ).toBe(1);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2022-05-17',
        }),
      ).toBe(2);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-17',
          endDate: '2025-05-17',
        }),
      ).toBe(5);
    });

    it('respects end date in config', () => {
      const config = {
        start: '2021-01-01',
        frequency: 'monthly' as const,
        endMode: 'on_date' as const,
        endDate: '2021-03-01',
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-12-31',
        }),
      ).toBe(3); // Jan, Feb, Mar only
    });

    it('respects end occurrences in config', () => {
      const config = {
        start: '2021-01-01',
        frequency: 'monthly' as const,
        endMode: 'after_n_occurrences' as const,
        endOccurrences: 3,
      };

      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-12-31',
        }),
      ).toBe(3); // Only 3 occurrences total
    });

    it('handles invalid date ranges', () => {
      const config = {
        start: '2021-01-01',
        frequency: 'daily' as const,
        endMode: 'never' as const,
      };

      // End before start
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-15',
          endDate: '2021-01-01',
        }),
      ).toBe(0);
    });

    it('handles dates before schedule start', () => {
      const config = {
        start: '2021-06-01',
        frequency: 'daily' as const,
        endMode: 'never' as const,
      };

      // Range ends before schedule starts
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-01-01',
          endDate: '2021-05-31',
        }),
      ).toBe(0);

      // Range starts before but includes schedule start
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-15',
          endDate: '2021-06-05',
        }),
      ).toBe(5); // June 1-5
    });

    it('handles weekend skipping with after mode', () => {
      const config = {
        start: '2021-05-01', // Saturday
        frequency: 'weekly' as const,
        skipWeekend: true,
        weekendSolveMode: 'after' as const,
        endMode: 'never' as const,
      };

      // Should move Saturday to Monday
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-01',
          endDate: '2021-05-02',
        }),
      ).toBe(0);
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-01',
          endDate: '2021-05-03',
        }),
      ).toBe(1); // Monday May 3
    });

    it('handles weekend skipping with before mode', () => {
      const config = {
        start: '2021-05-01', // Saturday
        frequency: 'weekly' as const,
        skipWeekend: true,
        weekendSolveMode: 'before' as const,
        endMode: 'never' as const,
      };

      // Saturday May 1 moved to Friday Apr 30
      // When counting from May 1, this occurrence is actually on Apr 30 (before the range)
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-04-30',
          endDate: '2021-05-06',
        }),
      ).toBe(1); // May 1 (Sat) -> Apr 30 (Fri)

      // Counting from May 1 to May 14 should get May 8 (Sat) -> May 7 (Fri)
      // May 15 (Sat) -> May 14 (Fri) is on the boundary
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-05-01',
          endDate: '2021-05-14',
        }),
      ).toBe(1); // Only May 8 -> May 7

      // Extend range to include May 15 -> May 14
      expect(
        countScheduleOccurrences({
          config,
          startDate: '2021-04-30',
          endDate: '2021-05-14',
        }),
      ).toBe(2); // May 1 -> Apr 30 and May 8 -> May 7
    });

    it('returns 0 for invalid inputs', () => {
      expect(
        countScheduleOccurrences({
          config: null,
          startDate: '2021-01-01',
          endDate: '2021-01-31',
        }),
      ).toBe(0);
      expect(
        countScheduleOccurrences({
          config: { start: '2021-01-01', frequency: 'daily', endMode: 'never' },
          startDate: '',
          endDate: '2021-01-31',
        }),
      ).toBe(0);
      expect(
        countScheduleOccurrences({
          config: { start: '2021-01-01', frequency: 'daily', endMode: 'never' },
          startDate: '2021-01-01',
          endDate: '',
        }),
      ).toBe(0);
    });
  });
});
