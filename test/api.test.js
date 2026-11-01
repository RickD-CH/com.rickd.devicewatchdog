'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const api = require('../api');

function fakeHomey() {
  const calls = [];
  const config = { config: { globalPausedUntilMs: 123 }, rules: [] };
  return {
    calls,
    homey: {
      app: {
        pauseGlobalFor: async (amount, unit) => {
          calls.push(['pauseGlobalFor', amount, unit]);
        },
        resumeGlobal: async () => {
          calls.push(['resumeGlobal']);
        },
        getConfig: () => config,
      },
    },
  };
}

describe('pause endpoints', () => {
  test('POST /pause hands amount and unit to the app and returns the config', async () => {
    const { homey, calls } = fakeHomey();
    const result = await api.pauseGlobal({ homey, body: { amount: 3, unit: 'hours' } });
    assert.deepEqual(calls, [['pauseGlobalFor', 3, 'hours']]);
    assert.equal(result.config.globalPausedUntilMs, 123);
  });

  test('POST /pause without a body is passed on as "nothing" and left to the app to reject', async () => {
    const { homey, calls } = fakeHomey();
    await api.pauseGlobal({ homey, body: undefined });
    assert.deepEqual(calls, [['pauseGlobalFor', undefined, undefined]]);
  });

  test('POST /pause/resume resumes and returns the config', async () => {
    const { homey, calls } = fakeHomey();
    const result = await api.resumeGlobalPause({ homey });
    assert.deepEqual(calls, [['resumeGlobal']]);
    assert.ok(result.config);
  });
});
