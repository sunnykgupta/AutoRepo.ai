#!/usr/bin/env node
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function denied() {
  throw new Error('Runtime transport-denial harness blocked a transport attempt.');
}

globalThis.fetch = denied;
globalThis.WebSocket = class DeniedWebSocket {
  constructor() {
    denied();
  }
};
globalThis.XMLHttpRequest = class DeniedXmlHttpRequest {
  constructor() {
    denied();
  }
};
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
net.connect = denied;
net.createConnection = denied;
net.Socket.prototype.connect = denied;

const { ConfluenceRenderFake, JiraProjectionFake } = await import(
  '../../integrations/fakes/atlassian-fakes.mjs'
);

const input = {
  id: 'SYNTHETIC-RUNTIME-1',
  title: 'Synthetic runtime transport-denial exercise',
  state: 'READY',
  dependencies: [],
};

for (const Fake of [JiraProjectionFake, ConfluenceRenderFake]) {
  const fake = new Fake();
  if (fake.preview(input).action !== 'created') throw new Error('Fake create exercise failed.');
  if (fake.preview(input).action !== 'noop') throw new Error('Fake no-op exercise failed.');
}

console.log(
  'Runtime transport-denial harness passed; this is in-process monkeypatching, not OS/network namespace denial.',
);
