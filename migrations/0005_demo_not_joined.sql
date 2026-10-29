-- The demo workspace is only for people who aren't signed in: no account has it in its joined list (recordJoin
-- refuses it for accounts from now on). Visitors of a server without sign-in ("guest:<id>" rows) keep theirs.
DELETE FROM joined WHERE workspace_id = 'demo' AND user_id NOT LIKE 'guest:%';
