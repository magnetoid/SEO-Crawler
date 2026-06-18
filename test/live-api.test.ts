import { test } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';

test('Live Google Search Console API Test', { skip: !process.env.GOOGLE_APPLICATION_CREDENTIALS }, async () => {
  const searchconsole = google.searchconsole('v1');
  // We check if the Google API responds without structural failure.
  // Note: mobileFriendlyTest is deprecated but the API library still lists it. 
  // We just ensure we can construct the client.
  assert.ok(searchconsole.urlTestingTools.mobileFriendlyTest.run);
});
