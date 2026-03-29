/**
 * Stub for utp-native — causes webtorrent to fall back to TCP-only mode.
 * utp-native uses libuv timers which Bun doesn't yet support (bun#18546).
 */
throw new Error('utp-native not supported in Bun — webtorrent will use TCP')
