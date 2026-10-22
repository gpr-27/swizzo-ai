// Fixture for the script adapter self-test: one pass, one fail, async exit(1).
console.log("  ✓ passes");
console.log("  ✗ fails", { why: "detail" });
setTimeout(() => process.exit(1), 0);
