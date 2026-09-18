const express = require("express");

const app = express();

app.use(express.json());

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

app.post("/v1/chat/completions", async (req, res) => {
  res.json({
    id: "test-relay",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "API relay test successful."
        }
      }
    ]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Codex Relay running on port ${PORT}`);
});
