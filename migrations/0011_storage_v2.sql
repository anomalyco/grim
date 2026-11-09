-- Storage v2 (docs/storage-v2.md): notes live in each workspace's Durable Object SQLite, with versions; there is no Git.
-- GitHub workspaces (linked and read-only copies) can't exist without Git: their rows go (joins cascade).
DELETE FROM repos WHERE kind = 'github';
