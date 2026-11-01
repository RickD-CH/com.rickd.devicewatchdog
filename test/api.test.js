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

  test('POST /pause with "until" (the Devices tab picker) pauses until that date and time', async () => {
    const { homey, calls } = fakeHomey();
    homey.app.pauseGlobalUntilDateTime = async (until) => {
      calls.push(['pauseGlobalUntilDateTime', until]);
    };
    const result = await api.pauseGlobal({ homey, body: { until: '2026-11-05T06:00' } });
    assert.deepEqual(calls, [['pauseGlobalUntilDateTime', '2026-11-05T06:00']]);
    assert.equal(result.config.globalPausedUntilMs, 123);
  });

  test('POST /pause with an empty "until" is still handed to the app (which rejects it), not treated as a duration', async () => {
    const { homey, calls } = fakeHomey();
    homey.app.pauseGlobalUntilDateTime = async (until) => {
      calls.push(['pauseGlobalUntilDateTime', until]);
    };
    await api.pauseGlobal({ homey, body: { until: '' } });
    assert.deepEqual(calls, [['pauseGlobalUntilDateTime', '']]);
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
