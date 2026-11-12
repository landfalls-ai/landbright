// Loaded first by main.ts: the workspace .env, then tracing, before Nest, http, pg or ioredis are required.
import { loadWorkspaceEnv } from '@landbright/platform';
import { startTelemetry } from '@landbright/platform/telemetry';

loadWorkspaceEnv();
startTelemetry('landbright-control');
