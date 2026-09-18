const express = require("express");

const app = express();

app.use(express.json());

// Allow requests from the GitHub Pages frontend
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

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
