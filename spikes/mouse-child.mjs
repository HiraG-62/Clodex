// ConPTY の中で動く子: マウスの報告を有効にし、stdin に届いたものをそのまま JSON で出す
process.stdout.write("\x1b[?1000h\x1b[?1006h");
process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  process.stdout.write(`GOT ${JSON.stringify(String(d))}\r\n`);
  if (String(d).includes("q")) { process.stdout.write("\x1b[?1006l\x1b[?1000l"); process.exit(0); }
});
process.stdout.write("READY\r\n");
