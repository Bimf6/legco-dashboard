import { runLegcoSync } from "../src/lib/legco-sync";

async function main() {
  const summary = await runLegcoSync("manual");
  console.log("Seed sync completed:", JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("Seed sync failed:", err);
  process.exit(1);
});
