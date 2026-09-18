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
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Codex Relay API is running"
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, model = "qwen3.5-27b" } = req.body;

    if (!DASHSCOPE_API_KEY) {
      return res.status(500).json({
        error: {
          message: "DASHSCOPE_API_KEY is not configured"
        }
      });
    }

    const response = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${DASHSCOPE_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Relay server error",
        details: error.message
      }
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Codex Relay running on port ${PORT}`);
});
