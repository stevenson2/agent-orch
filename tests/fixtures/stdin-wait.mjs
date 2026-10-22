// Mimics `codex exec`: it announces that it is reading stdin and does not
// finish until that stream ends. An open pipe hangs the run.
process.stderr.write("Reading additional input from stdin...\n");
const timer = setTimeout(() => {
  process.stderr.write("still waiting for stdin\n");
  process.exit(2);
}, 1500);
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  clearTimeout(timer);
  process.stdout.write("stdin-closed\n");
  process.exit(0);
});
process.stdin.resume();
