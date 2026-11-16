import { connect, createServer, type Server, type Socket } from 'node:net';

// forwards each connection on port to the port target() names when it arrives. a target that
// refuses, like a server restarting, is retried while the client waits, so no request is lost.
// servers close idle keep-alive connections within seconds, so a new target takes over
// connections soon after a switch. bun's pause() drops what arrives meanwhile, so bytes are
// held by hand until the target connects
export function proxy(port: number, target: () => number, waitMs = 120_000): Promise<Server> {
  const server = createServer((client) => {
    const deadline = Date.now() + waitMs;
    const held: Buffer[] = [];
    let up: Socket | undefined;
    let joined = false;
    let ended = false;
    client.on('data', (d: Buffer) => (joined ? up!.write(d) : held.push(d)));
    client.on('end', () => (joined ? up!.end() : (ended = true)));
    client.on('error', () => up?.destroy());
    client.on('close', () => up?.destroy());
    const attempt = () => {
      if (client.destroyed) return;
      const u = connect(target(), '127.0.0.1');
      up = u;
      u.once('connect', () => {
        joined = true;
        for (const d of held.splice(0)) u.write(d);
        if (ended) u.end();
        u.on('data', (d) => client.write(d));
        u.on('end', () => client.end());
      });
      u.on('error', () => {
        u.destroy();
        if (joined || Date.now() > deadline) client.destroy();
        else setTimeout(attempt, 500);
      });
      u.on('close', () => joined && client.destroy());
    };
    attempt();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}
