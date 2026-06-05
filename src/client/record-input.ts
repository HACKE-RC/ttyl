export function attachLocalInput(child: { write(data: string | Buffer): void }): () => void {
  const stdin = process.stdin;
  const isTty = Boolean(stdin.isTTY);
  const wasRaw = isTty ? stdin.isRaw : false;
  const onData = (buf: Buffer): void => child.write(buf);
  if (isTty) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    stdin.removeListener("data", onData);
    if (isTty) {
      stdin.setRawMode(wasRaw);
    }
    stdin.pause();
  };
}
