// Removed.
//
// This announced the device on the local network by UDP multicast and dialled
// whatever answered, so two machines on the same wifi paired with nothing
// typed in. It worked, and it is gone on purpose.
//
// It broadcast a local IP address. Everything else now goes through Tor
// precisely so no address is ever revealed, and a single fallback that leaks
// one undoes that for the whole application — the worst kind of leak, because
// it only fires in the case that "just works" and therefore never gets
// questioned.
//
// Peers are reached by onion address only. See tor.ts and transport.ts.

export {};
