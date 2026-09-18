const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Codex Relay API is running"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Codex Relay running on port ${PORT}`);
});
