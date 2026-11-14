import { describe, expect, it } from 'vitest';
import { changedFields, isoDate, workerFromHiBob } from '../src/worker';
import { EMPLOYEES, machineFormat } from './fake-hibob';

const NOA = {
  source: 'hibob',
  sourceId: '3332883884017713238',
  email: 'noa.barak@landbright.test',
  givenName: 'Noa',
  familyName: 'Barak',
  displayName: 'Noa Barak',
  department: 'Engineering',
  title: 'Platform Engineer',
  site: 'Tel Aviv',
  managerEmail: 'maya.cohen@landbright.test',
  startDate: '2026-11-21',
  endDate: null,
  status: 'hired',
};

describe('the worker', () => {
  it("reads Bob's flat machine format, names of list fields from humanReadable", () => {
    expect(workerFromHiBob(machineFormat(EMPLOYEES[0]))).toEqual(NOA);
  });

  it('reads the nested format, root fields at the top or under root', () => {
    const nested = {
      id: '3332883884017713238',
      email: 'Noa.Barak@landbright.test',
      firstName: 'Noa',
      surname: 'Barak',
      work: {
        department: 'Engineering',
        title: 'Platform Engineer',
        site: 'Tel Aviv',
        reportsTo: { id: '1', email: 'maya.cohen@landbright.test' },
        startDate: '21/11/2026',
      },
      internal: { lifecycleStatus: 'Hired', terminationDate: null },
    };
    expect(workerFromHiBob(nested)).toEqual(NOA);
    expect(workerFromHiBob({ root: { id: 'x1', email: 'a@b.test', firstName: 'A', surname: 'B' } })).toMatchObject({
      sourceId: 'x1',
      email: 'a@b.test',
      displayName: 'A B',
      department: null,
    });
  });

  it('prefers the appended human-readable names in the nested format', () => {
    const employee = {
      id: 'x2',
      email: 'c@d.test',
      work: { department: '1234' },
      humanReadable: { work: { department: 'Finance' } },
    };
    expect(workerFromHiBob(employee).department).toBe('Finance');
  });

  it('needs an id', () => {
    expect(() => workerFromHiBob({ email: 'x@y.test' })).toThrow(/no id/);
  });

  it('normalizes dates', () => {
    expect([
      isoDate('2026-11-21'),
      isoDate('2026-11-21T00:00:00Z'),
      isoDate('1/2/2027'),
      isoDate('soon'),
      isoDate(null),
    ]).toEqual(['2026-11-21', '2026-11-21', '2027-02-01', null, null]);
  });

  it('reads changed fields from fieldUpdates or fieldUpdatesIds', () => {
    expect(
      changedFields({
        fieldUpdates: [{ id: 'work.title', oldValue: 'a', newValue: 'b' }, { fieldId: 'work.department' }],
      }),
    ).toEqual(['work.title', 'work.department']);
    expect(changedFields({ fieldUpdatesIds: ['work.reportsTo', { id: 'work.site' }] })).toEqual([
      'work.reportsTo',
      'work.site',
    ]);
    expect(changedFields(undefined)).toEqual([]);
  });
});
