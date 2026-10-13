// Separate release entrypoint. Never selected by the production standby builder.
import { runExecutionRuntime } from './execution-runtime.js';
await runExecutionRuntime('production');
