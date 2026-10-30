-- App tokens for one resource only (RFC 8707): "mcp" for tokens an MCP client got through OAuth (src/server/oauth.ts),
-- which work at /mcp and nowhere else. NULL: an app token (the Mac app), which works everywhere (and at /mcp too).
ALTER TABLE app_tokens ADD COLUMN audience TEXT;
ALTER TABLE connect_codes ADD COLUMN audience TEXT;
