-- The demo workspace's row (Bun's index.ts puts it in at startup through seedDemo). Nobody owns it, so nobody can
-- remove it. Its notes live in its WorkspaceDO (src/workers/demo.ts), seeded there on first open.
INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('demo', 'Demo', 'notes', 'main', 'ready', CAST(strftime('%s', 'now') AS INTEGER) * 1000) ON CONFLICT (id) DO NOTHING
