import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectUrl } from '../server.js';

test('rejectUrl: allows a normal public https URL', () => {
  assert.equal(rejectUrl('https://example.com/sitemap.xml'), null);
});

test('rejectUrl: blocks non-http(s) schemes', () => {
  assert.match(rejectUrl('file:///etc/passwd'), /http and https/i);
  assert.match(rejectUrl('ftp://example.com'), /http and https/i);
});

test('rejectUrl: blocks localhost and loopback', () => {
  assert.match(rejectUrl('http://localhost:8080/'), /local/i);
  assert.match(rejectUrl('http://127.0.0.1/'), /private/i);
  assert.match(rejectUrl('http://[::1]/'), /private/i);
});

test('rejectUrl: blocks private IPv4 ranges', () => {
  assert.match(rejectUrl('http://10.0.0.5/'), /private/i);
  assert.match(rejectUrl('http://192.168.1.1/'), /private/i);
  assert.match(rejectUrl('http://172.16.0.1/'), /private/i);
  assert.match(rejectUrl('http://169.254.1.1/'), /private/i);
});

test('rejectUrl: rejects malformed URLs', () => {
  assert.match(rejectUrl('not a url'), /invalid url/i);
});
