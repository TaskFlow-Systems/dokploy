// ssh2 sends no keepalive by default, so a dead network leaves the socket open
// with no error and a command over it waits forever. 15 s × 4 missed replies
// reports the loss after 75 s.
export const SSH_KEEPALIVE = {
	keepaliveInterval: 15_000,
	keepaliveCountMax: 4,
};
