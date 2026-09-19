const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

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
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function getApiKey(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return auth.slice(7).trim();
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Codex Relay API is running"
  });
});

app.post("/admin/create-key", async (req, res) => {
  try {
    const apiKey = "cr_" + crypto.randomBytes(24).toString("hex");

    await pool.query(
      `INSERT INTO api_keys ("key", balance, total_tokens)
       VALUES ($1, $2, $3)`,
      [apiKey, 0, 0]
    );

    res.json({
      success: true,
      api_key: apiKey
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to create API key",
        details: error.message
      }
    });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    if (!DASHSCOPE_API_KEY) {
      return res.status(500).json({
        error: {
          message: "DASHSCOPE_API_KEY is not configured"
        }
      });
    }

    if (!DATABASE_URL) {
      return res.status(500).json({
        error: {
          message: "DATABASE_URL is not configured"
        }
      });
    }

    const apiKey = getApiKey(req);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: "Missing API key"
        }
      });
    }

    const keyResult = await pool.query(
      `SELECT * FROM api_keys WHERE "key" = $1`,
      [apiKey]
    );

    if (keyResult.rows.length === 0) {
      return res.status(401).json({
        error: {
          message: "Invalid API key"
        }
      });
    }

    const { messages, model = "qwen3.5-27b" } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: "messages must be an array"
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

    const inputTokens = data?.usage?.prompt_tokens || 0;
    const outputTokens = data?.usage?.completion_tokens || 0;
    const totalTokens = data?.usage?.total_tokens || 0;

    await pool.query(
      `UPDATE api_keys
       SET total_tokens = total_tokens + $1
       WHERE "key" = $2`,
      [totalTokens, apiKey]
    );

    await pool.query(
      `INSERT INTO usage_logs
       (api_key, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4)`,
      [apiKey, model, inputTokens, outputTokens]
    );

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
