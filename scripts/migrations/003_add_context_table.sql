-- scripts/migrations/003_add_context_table.sql
-- Shared context store for cross-machine Claude session memory

CREATE TABLE IF NOT EXISTS timeline.context (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    thread_id INT REFERENCES timeline.threads(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('project', 'pr', 'machine', 'waiting', 'fact')),
    label TEXT,
    source TEXT,
    pinned BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_context_category ON timeline.context(category);
CREATE INDEX IF NOT EXISTS idx_context_thread ON timeline.context(thread_id);
CREATE INDEX IF NOT EXISTS idx_context_pinned ON timeline.context(pinned) WHERE pinned = TRUE;
CREATE INDEX IF NOT EXISTS idx_context_expires ON timeline.context(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_updated ON timeline.context(updated_at DESC);

COMMENT ON TABLE timeline.context IS 'Shared context store for cross-machine Claude session memory';
COMMENT ON COLUMN timeline.context.key IS 'Namespaced key, e.g., project:meshcore-monitor, pr:Yeraze/meshmonitor:1777';
COMMENT ON COLUMN timeline.context.category IS 'Category for filtering: project, pr, machine, waiting, fact';
COMMENT ON COLUMN timeline.context.source IS 'Machine hostname that wrote this entry';
COMMENT ON COLUMN timeline.context.pinned IS 'If true, always show in /whereami';
COMMENT ON COLUMN timeline.context.expires_at IS 'Auto-delete after this time (for temp clipboard items)';
