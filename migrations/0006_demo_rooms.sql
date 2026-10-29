-- The demo is now rooms of at most 10 people (src/server/demo-rooms.ts), each its own workspace "demo.<room>" whose
-- row the demo's lobby makes and deletes. "demo" itself is only an alias the clients resolve: its old shared row
-- goes (its agent links and joins with it).
DELETE FROM repos WHERE id = 'demo';
