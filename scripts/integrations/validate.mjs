#!/usr/bin/env node
import {
  runRuntimeTransportDenialHarness,
  runtimeBoundaryDescription,
  validateIntegrationBoundary,
} from '../integration-boundary.mjs';

const errors = validateIntegrationBoundary();
const runtime = runRuntimeTransportDenialHarness();
if (runtime.status !== 0) errors.push(`runtime transport-denial harness failed: ${runtime.output.trim()}`);
if (errors.length > 0) {
  console.error(`Fake integration boundary validation failed:\n${errors.map((entry) => `- ${entry}`).join('\n')}`);
  process.exitCode = 1;
} else {
  process.stdout.write(runtime.output);
  console.log(
    `Fake integration boundary validation passed: closed synthetic fixtures and no transport surface. ${runtimeBoundaryDescription()}`,
  );
}
