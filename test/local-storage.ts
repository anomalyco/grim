// Tests and scratch servers never touch Code Storage. Import this before the server (bun test's preload does; e2e
// scripts and tools import it first): it forces STORAGE=local and drops every CODE_STORAGE_* variable, whatever the
// environment says, and marks the process (and its children) as a test so startServer refuses any other store.
for (const name of Object.keys(process.env)) if (name.startsWith("CODE_STORAGE_")) delete process.env[name];
process.env.STORAGE = "local";
process.env.GRIMOIRE_TEST = "1";
