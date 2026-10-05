// Reconnecting NDJSON client from a proxy to the hub's unix socket.
// Never throws into the relay: if the hub is down, messages are buffered (bounded).
import net from "node:net";
import { onLines, tryParse } from "../lines.ts";

export const BUFFER_CAP = 5000;

export class HubLink {
  private sock: string;
  private hello: () => object;
  private onCommand: (cmd: any) => Promise<any>;
  private socket: net.Socket | null = null;
  private connected = false;
  private buffer: string[] = [];
  private closed = false;
  private retryMs = 250;

  constructor(sock: string, hello: () => object, onCommand: (cmd: any) => Promise<any>) {
    this.sock = sock;
    this.hello = hello;
    this.onCommand = onCommand;
    this.connect();
  }

  send(obj: object): void {
    const line = JSON.stringify(obj) + "\n";
    if (this.connected && this.socket) {
      this.socket.write(line);
      return;
    }
    this.buffer.push(line);
    if (this.buffer.length > BUFFER_CAP) this.buffer.shift();
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }

  private connect(): void {
    if (this.closed) return;
    const s = net.createConnection(this.sock);
    s.unref();
    this.socket = s;
    s.on("connect", () => {
      this.connected = true;
      this.retryMs = 250;
      s.write(JSON.stringify(this.hello()) + "\n");
      for (const line of this.buffer.splice(0)) s.write(line);
    });
    onLines(s, (line) => {
      const m = tryParse(line);
      if (m?.type !== "cmd") return;
      this.onCommand(m).then(
        (result) => this.reply({ type: "reply", id: m.id, result: result ?? null }),
        (err) => this.reply({ type: "reply", id: m.id, error: { message: err?.message ?? String(err), code: err?.code } }),
      );
    });
    const retry = () => {
      if (this.socket !== s) return;
      this.connected = false;
      this.socket = null;
      if (this.closed) return;
      const t = setTimeout(() => this.connect(), this.retryMs);
      t.unref();
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
    s.on("error", retry);
    s.on("close", retry);
  }

  private reply(obj: object): void {
    if (this.connected && this.socket) this.socket.write(JSON.stringify(obj) + "\n");
  }
}
