// Removed.
//
// Discord rich presence published what you were doing to a local Discord
// client, which then reported it to Discord. That sits badly with an app
// that routes every byte through Tor specifically so no third party learns
// anything about who is talking to whom.
//
// Kept as an empty module so a stale build with a cached import still
// resolves. Safe to delete once everything has been rebuilt.

export {};
