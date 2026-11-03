-- Agent (MCP) call journal: exactly-once semantics for tools/call retries. A row starts 'pending'
-- before any fee moves and ends 'done' with the full result, so a retried Idempotency-Key replays
-- the stored answer instead of charging again. A row left 'pending' is an UNKNOWN outcome: never
-- re-run, reconciliation-required (see src/mcp.ts). An Idempotency-Key names one exact call:
-- this user (in the key), this tool, these arguments (args_hash).
CREATE TABLE mcp_call (
  idempotency_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
