-- Agent share links (/a/<uuid>) were replaced by the workspace URL itself: /app/<workspace> answers agents
-- (src/server/agent-url.ts), with guest rules or an app token's. Nothing reads this table any more.
DROP INDEX IF EXISTS share_links_repo;
DROP TABLE IF EXISTS share_links;
