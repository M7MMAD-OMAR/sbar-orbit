/** Read-only help for the unavailable legacy probe; never starts a child. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("UNAVAILABLE: live reader scope probe requires qualified atomic child creation and admission. No desktop/app operations.");
    return;
  }
  if (args.length !== 1 || args[0] !== "--run")
    throw new Error("Use --help; the live reader scope probe is unavailable");
  throw new Error("UNAVAILABLE: live reader scope probe requires qualified atomic child creation and admission");
}
if (import.meta.main) await main();
